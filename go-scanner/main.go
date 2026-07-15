package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Candle struct {
	T int64   `json:"t"`
	O float64 `json:"o"`
	H float64 `json:"h"`
	L float64 `json:"l"`
	C float64 `json:"c"`
	V float64 `json:"v"`
}

type Ticker struct {
	Key  string  `json:"key"`
	Ex   string  `json:"ex"`
	Sym  string  `json:"sym"`
	Base string  `json:"base"`
	P    float64 `json:"p"`
	V    float64 `json:"v"`
}

type BinCandle struct {
	T int64
	O float64
	H float64
	L float64
	C float64
	V float64
}

type BackfillTask struct {
	Ex  string
	Sym string
}

var (
	candlesMu     sync.RWMutex
	candlesDB     = make(map[string][]Candle)
	dataDir       = "./data/candles"
	backfillQueue = make(chan BackfillTask, 1000)
	queuedCoins   = make(map[string]bool)
	queuedMu      sync.Mutex
)

func enqueueBackfill(ex, sym string) {
	key := ex + ":" + sym

	// Quick check if already loaded to memory
	candlesMu.RLock()
	_, exists := candlesDB[key]
	candlesMu.RUnlock()
	if exists {
		return
	}

	queuedMu.Lock()
	defer queuedMu.Unlock()
	if queuedCoins[key] {
		return
	}
	queuedCoins[key] = true

	select {
	case backfillQueue <- BackfillTask{Ex: ex, Sym: sym}:
		log.Printf("[QUEUE] Queued backfill for %s", key)
	default:
		delete(queuedCoins, key)
		log.Printf("[QUEUE WARNING] Backfill queue is full, skipped %s", key)
	}
}

func startBackfillWorker() {
	go func() {
		for task := range backfillQueue {
			key := task.Ex + ":" + task.Sym

			candlesMu.RLock()
			_, exists := candlesDB[key]
			candlesMu.RUnlock()

			if !exists {
				backfillCoinHistory(task.Ex, task.Sym)
				// Delay between processing different coins to protect IP from Binance rate limit
				time.Sleep(1500 * time.Millisecond)
			}

			queuedMu.Lock()
			delete(queuedCoins, key)
			queuedMu.Unlock()
		}
	}()
}

const MaxCandles = 12000

func getFilePath(key string) string {
	safeKey := strings.ReplaceAll(key, ":", "_")
	return filepath.Join(dataDir, safeKey+"_1m.bin")
}

func saveCandlesToDisk(key string, list []Candle) error {
	path := getFilePath(key)
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	buf := new(bytes.Buffer)
	for _, c := range list {
		bc := BinCandle{
			T: c.T,
			O: c.O, H: c.H, L: c.L, C: c.C, V: c.V,
		}
		if err := binary.Write(buf, binary.LittleEndian, bc); err != nil {
			return err
		}
	}
	return os.WriteFile(path, buf.Bytes(), 0644)
}

func loadCandlesFromDisk(key string) ([]Candle, error) {
	path := getFilePath(key)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	r := bytes.NewReader(data)
	var list []Candle
	for {
		var bc BinCandle
		if err := binary.Read(r, binary.LittleEndian, &bc); err != nil {
			if err == io.EOF {
				break
			}
			return nil, err
		}
		list = append(list, Candle{
			T: bc.T,
			O: bc.O, H: bc.H, L: bc.L, C: bc.C, V: bc.V,
		})
	}
	return list, nil
}

func aggregateCandles(src []Candle, tfMinutes int) []Candle {
	if len(src) == 0 {
		return nil
	}
	if tfMinutes <= 1 {
		return src
	}

	var res []Candle
	var cur *Candle
	tfMs := int64(tfMinutes) * 60 * 1000

	for _, c := range src {
		intervalStart := (c.T / tfMs) * tfMs

		if cur == nil || intervalStart != cur.T {
			if cur != nil {
				res = append(res, *cur)
			}
			cur = &Candle{
				T: intervalStart,
				O: c.O, H: c.H, L: c.L, C: c.C, V: c.V,
			}
		} else {
			if c.H > cur.H {
				cur.H = c.H
			}
			if c.L < cur.L {
				cur.L = c.L
			}
			cur.C = c.C
			cur.V += c.V
		}
	}

	if cur != nil {
		res = append(res, *cur)
	}
	return res
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
}

func parseTimeframe(tf string) int {
	switch tf {
	case "1m":
		return 1
	case "5m":
		return 5
	case "15m":
		return 15
	case "1h":
		return 60
	case "4h":
		return 240
	case "1d":
		return 1440
	default:
		return 60
	}
}

func klinesHandler(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	ex := r.URL.Query().Get("ex")
	sym := r.URL.Query().Get("sym")
	tf := r.URL.Query().Get("tf")
	limitStr := r.URL.Query().Get("limit")

	if ex == "" || sym == "" {
		http.Error(w, `{"error":"Missing ex or sym parameters"}`, 400)
		return
	}

	key := ex + ":" + sym
	candlesMu.RLock()
	list, exists := candlesDB[key]
	candlesMu.RUnlock()

	if !exists {
		var err error
		list, err = loadCandlesFromDisk(key)
		if err != nil || len(list) == 0 {
			enqueueBackfill(ex, sym)
			http.Error(w, `{"error":"History not loaded yet, loading initiated"}`, 202)
			return
		}
		candlesMu.Lock()
		candlesDB[key] = list
		candlesMu.Unlock()
	}

	tfMins := parseTimeframe(tf)
	aggregated := aggregateCandles(list, tfMins)

	limit := len(aggregated)
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l < limit {
			limit = l
		}
	}

	offset := len(aggregated) - limit
	if offset < 0 {
		offset = 0
	}
	result := aggregated[offset:]

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func backfillCoinHistory(ex, sym string) {
	key := ex + ":" + sym
	log.Printf("[SYNC] Backfilling history for %s...", key)

	var candles []Candle
	var err error

	if ex == "BN" {
		candles, err = downloadBinanceHistory(sym, MaxCandles)
	} else {
		candles, err = downloadBinanceHistory(sym, MaxCandles)
	}

	if err != nil {
		log.Printf("[SYNC ERROR] Failed to download history for %s: %v", key, err)
		return
	}

	if len(candles) > 0 {
		candlesMu.Lock()
		candlesDB[key] = candles
		candlesMu.Unlock()

		if err := saveCandlesToDisk(key, candles); err != nil {
			log.Printf("[SYNC ERROR] Failed saving %s to disk: %v", key, err)
		} else {
			log.Printf("[SYNC] Successfully synced %d candles for %s", len(candles), key)
		}
	}
}

func downloadBinanceHistory(sym string, total int) ([]Candle, error) {
	var all []Candle
	limit := 1000
	endTime := time.Now().UnixMilli()

	client := &http.Client{Timeout: 15 * time.Second}

	for len(all) < total {
		url := fmt.Sprintf("https://fapi.binance.com/fapi/v1/klines?symbol=%s&interval=1m&limit=%d&endTime=%d", sym, limit, endTime)
		resp, err := client.Get(url)
		if err != nil {
			return all, err
		}

		if resp.StatusCode == 429 || resp.StatusCode == 418 {
			resp.Body.Close()
			log.Printf("[RATE LIMIT] Hit rate limit/ban (HTTP %d) on Binance. Pausing backfill worker for 60 seconds...", resp.StatusCode)
			time.Sleep(60 * time.Second)
			continue
		}

		if resp.StatusCode != 200 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return all, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
		}

		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return all, err
		}

		// Check if response is an error object (not an array)
		if len(body) > 0 && body[0] == '{' {
			var apiErr struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			json.Unmarshal(body, &apiErr)
			return all, fmt.Errorf("binance API error %d: %s", apiErr.Code, apiErr.Msg)
		}

		var raw [][]interface{}
		if err := json.Unmarshal(body, &raw); err != nil {
			return all, fmt.Errorf("json parse error: %v (body: %.100s)", err, string(body))
		}

		if len(raw) == 0 {
			break
		}

		var batch []Candle
		for _, k := range raw {
			if len(k) < 6 {
				continue
			}
			batch = append(batch, Candle{
				T: int64(k[0].(float64)),
				O: parseF(k[1]), H: parseF(k[2]), L: parseF(k[3]), C: parseF(k[4]), V: parseF(k[5]),
			})
		}

		all = append(batch, all...)
		endTime = batch[0].T - 1

		if len(raw) < limit {
			break
		}
		// Delay between pagination requests of the SAME coin to avoid burst rate limit
		time.Sleep(400 * time.Millisecond)
	}

	if len(all) > total {
		all = all[len(all)-total:]
	}
	return all, nil
}

func parseF(v interface{}) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	}
	return 0
}

func startBinanceWS(symbols []string) {
	if len(symbols) == 0 {
		return
	}

	log.Printf("[WS] Connecting to Binance kline streams for %d symbols...", len(symbols))

	streams := make([]string, len(symbols))
	for i, s := range symbols {
		streams[i] = strings.ToLower(s) + "@kline_1m"
	}
	url := "wss://fstream.binance.com/stream?streams=" + strings.Join(streams, "/")

	go func() {
		for {
			conn, _, err := websocket.DefaultDialer.Dial(url, nil)
			if err != nil {
				log.Printf("[WS ERROR] Dial error: %v, reconnecting in 5s...", err)
				time.Sleep(5 * time.Second)
				continue
			}
			log.Println("[WS] Connected to Binance Kline WebSocket")

			for {
				_, msg, err := conn.ReadMessage()
				if err != nil {
					log.Printf("[WS CLOSE] Connection closed: %v, reconnecting...", err)
					break
				}

				var payload struct {
					Stream string `json:"stream"`
					Data   struct {
						S string `json:"s"`
						K struct {
							T int64  `json:"t"`
							O string `json:"o"`
							H string `json:"h"`
							L string `json:"l"`
							C string `json:"c"`
							V string `json:"v"`
							X bool   `json:"x"`
						} `json:"k"`
					} `json:"data"`
				}

				if err := json.Unmarshal(msg, &payload); err != nil {
					continue
				}

				k := payload.Data.K
				if !k.X {
					continue
				}

				key := "BN:" + payload.Data.S
				newCandle := Candle{
					T: k.T,
					O: parseF(k.O), H: parseF(k.H), L: parseF(k.L), C: parseF(k.C), V: parseF(k.V),
				}

				candlesMu.Lock()
				list := candlesDB[key]
				if len(list) > 0 && list[len(list)-1].T == newCandle.T {
					list[len(list)-1] = newCandle
				} else {
					list = append(list, newCandle)
				}

				if len(list) > MaxCandles {
					list = list[1:]
				}
				candlesDB[key] = list
				candlesMu.Unlock()

				go func(cKey string, cList []Candle) {
					if err := saveCandlesToDisk(cKey, cList); err != nil {
						log.Printf("[DISK ERROR] Failed saving %s: %v", cKey, err)
					}
				}(key, list)
			}
			conn.Close()
			time.Sleep(2 * time.Second)
		}
	}()
}

func getTopSymbolsFromNode() ([]string, error) {
	resp, err := http.Get("http://127.0.0.1:3000/api/tickers")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var raw []interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}

	var symbols []string
	step := 11
	for i := 0; i < len(raw); i += step {
		if i+3 >= len(raw) {
			break
		}
		key, ok := raw[i].(string)
		if !ok {
			continue
		}
		parts := strings.Split(key, ":")
		if len(parts) == 2 && parts[0] == "BN" {
			symbols = append(symbols, parts[1])
		}
	}
	return symbols, nil
}

func main() {
	log.Println("=== Starting Go Kline & Scanner Engine ===")

	// Start sequential backfill task queue worker
	startBackfillWorker()

	var symbols []string
	var err error
	for i := 0; i < 5; i++ {
		symbols, err = getTopSymbolsFromNode()
		if err == nil && len(symbols) > 0 {
			break
		}
		log.Printf("[INIT] Waiting for Node.js server to be active... (%v)", err)
		time.Sleep(3 * time.Second)
	}

	if len(symbols) == 0 {
		log.Println("[INIT] No symbols retrieved, using defaults")
		symbols = []string{"BTCUSDT", "ETHUSDT", "SOLUSDT"}
	}

	if len(symbols) > 80 {
		symbols = symbols[:80]
	}

	log.Println("[INIT] Pre-loading binary history from disk cache...")
	for _, s := range symbols {
		key := "BN:" + s
		list, err := loadCandlesFromDisk(key)
		if err == nil && len(list) > 0 {
			candlesMu.Lock()
			candlesDB[key] = list
			candlesMu.Unlock()
			log.Printf("[INIT] Pre-loaded %d candles for %s", len(list), key)
		} else {
			enqueueBackfill("BN", s)
		}
	}

	startBinanceWS(symbols)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/klines", klinesHandler)

	log.Println("Go Server listening on :8082")
	log.Fatal(http.ListenAndServe(":8082", mux))
}
