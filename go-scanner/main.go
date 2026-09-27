package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
	dataDir       = "./data/candles-quote-v2" // old files stored base volume, incompatible with Node candles
	backfillQueue = make(chan BackfillTask, 1000)
	queuedCoins   = make(map[string]bool)
	queuedMu      sync.Mutex
	diskDirty     = make(map[string]bool) // protected by candlesMu
)

var validSymbol = regexp.MustCompile(`^[A-Z0-9]{1,40}USDT$`)

func freshHistory(list []Candle) bool {
	if len(list) < 2 || time.Since(time.UnixMilli(list[len(list)-1].T)) > 2*time.Minute {
		return false
	}
	for i := 1; i < len(list); i++ {
		if list[i].T-list[i-1].T != 60000 {
			return false
		}
	}
	return true
}

func enqueueBackfill(ex, sym string) {
	if ex != "BN" || !validSymbol.MatchString(sym) {
		return
	}
	key := ex + ":" + sym

	// Quick check if already loaded to memory
	candlesMu.RLock()
	ready := freshHistory(candlesDB[key])
	candlesMu.RUnlock()
	if ready {
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

			// A new live tail does not satisfy a queued history recovery.
			backfillCoinHistory(task.Ex, task.Sym)
			// Delay between coins to respect the exchange rate limit.
			time.Sleep(1500 * time.Millisecond)

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
	if err := os.WriteFile(path+".tmp", buf.Bytes(), 0644); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

// One writer coalesces updates. No goroutine retains a mutable candle slice,
// and two saves of the same symbol can never overwrite each other out of order.
func flushDirtyCandles() {
	candlesMu.Lock()
	keys := make([]string, 0, len(diskDirty))
	for key := range diskDirty {
		keys = append(keys, key)
	}
	diskDirty = make(map[string]bool)
	candlesMu.Unlock()
	for _, key := range keys {
		candlesMu.RLock()
		list := append([]Candle(nil), candlesDB[key]...)
		candlesMu.RUnlock()
		if err := saveCandlesToDisk(key, list); err != nil {
			log.Printf("[DISK ERROR] Failed saving %s: %v", key, err)
			candlesMu.Lock()
			diskDirty[key] = true
			candlesMu.Unlock()
		}
	}
}

func ingestClosedCandle(key string, candle Candle) bool {
	if !validCandle(candle) {
		return false
	}
	candlesMu.Lock()
	list := candlesDB[key]
	gap := len(list) > 0 && candle.T-list[len(list)-1].T > 60000
	if len(list) > 0 && candle.T < list[len(list)-1].T {
		candlesMu.Unlock()
		return false
	}
	if len(list) > 0 && list[len(list)-1].T == candle.T {
		list[len(list)-1] = candle
	} else {
		list = append(list, candle)
	}
	if len(list) > MaxCandles {
		list = append([]Candle(nil), list[len(list)-MaxCandles:]...)
	}
	candlesDB[key] = list
	diskDirty[key] = true
	candlesMu.Unlock()
	// enqueueBackfill acquires candlesMu itself: never call it under that lock.
	if gap {
		parts := strings.SplitN(key, ":", 2)
		if len(parts) == 2 {
			enqueueBackfill(parts[0], parts[1])
		}
	}
	return true
}

func validCandle(c Candle) bool {
	if c.T <= 0 || c.T > time.Now().Add(time.Minute).UnixMilli() {
		return false
	}
	for _, value := range []float64{c.O, c.H, c.L, c.C, c.V} {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return c.O > 0 && c.C > 0 && c.L > 0 && c.V >= 0 && c.H >= math.Max(c.O, c.C) && c.L <= math.Min(c.O, c.C)
}

func mergeHistory(key string, history []Candle) {
	candlesMu.Lock()
	defer candlesMu.Unlock()
	byTime := make(map[int64]Candle, len(history)+len(candlesDB[key]))
	for _, c := range history {
		if validCandle(c) {
			byTime[c.T] = c
		}
	}
	// A candle received while REST was pending wins over the REST snapshot.
	for _, c := range candlesDB[key] {
		byTime[c.T] = c
	}
	merged := make([]Candle, 0, len(byTime))
	for _, c := range byTime {
		merged = append(merged, c)
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].T < merged[j].T })
	if len(merged) > MaxCandles {
		merged = merged[len(merged)-MaxCandles:]
	}
	candlesDB[key] = merged
	diskDirty[key] = true
}

func loadCandlesFromDisk(key string) ([]Candle, error) {
	path := getFilePath(key)
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(MaxCandles*48+1)))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxCandles*48 {
		return nil, fmt.Errorf("oversized candle cache")
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
		candle := Candle{
			T: bc.T,
			O: bc.O, H: bc.H, L: bc.L, C: bc.C, V: bc.V,
		}
		if !validCandle(candle) {
			return nil, fmt.Errorf("invalid candle cache")
		}
		list = append(list, candle)
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
	if ex != "BN" || !validSymbol.MatchString(sym) {
		http.Error(w, `{"error":"Unsupported market"}`, 400)
		return
	}

	key := ex + ":" + sym
	candlesMu.RLock()
	list, exists := candlesDB[key]
	list = append([]Candle(nil), list...)
	candlesMu.RUnlock()

	if !exists {
		var err error
		list, err = loadCandlesFromDisk(key)
		if err != nil || len(list) == 0 {
			enqueueBackfill(ex, sym)
			http.Error(w, `{"error":"History not loaded yet, loading initiated"}`, 202)
			return
		}
		if !freshHistory(list) {
			enqueueBackfill(ex, sym)
			http.Error(w, `{"error":"History is stale, backfill queued"}`, 202)
			return
		}
		mergeHistory(key, list)
	}

	// Double check memory data freshness
	if !freshHistory(list) {
		enqueueBackfill(ex, sym)
		http.Error(w, `{"error":"History is stale, backfill queued"}`, 202)
		return
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

	if ex != "BN" || !validSymbol.MatchString(sym) {
		return
	}
	candles, err = downloadBinanceHistory(sym, MaxCandles)

	if err != nil {
		log.Printf("[SYNC ERROR] Failed to download history for %s: %v", key, err)
		return
	}

	if len(candles) > 0 {
		mergeHistory(key, candles)
		log.Printf("[SYNC] Successfully synced %d candles for %s", len(candles), key)
	}
}

func downloadBinanceHistory(sym string, total int) ([]Candle, error) {
	var all []Candle
	limit := 1000
	endTime := time.Now().UnixMilli()
	rateLimitRetries := 0

	client := &http.Client{Timeout: 15 * time.Second}

	for len(all) < total {
		url := fmt.Sprintf("https://fapi.binance.com/fapi/v1/klines?symbol=%s&interval=1m&limit=%d&endTime=%d", sym, limit, endTime)
		resp, err := client.Get(url)
		if err != nil {
			return all, err
		}

		if resp.StatusCode == 429 || resp.StatusCode == 418 {
			resp.Body.Close()
			rateLimitRetries++
			if rateLimitRetries > 2 {
				return nil, fmt.Errorf("binance backfill rate limited")
			}
			log.Printf("[RATE LIMIT] Hit rate limit/ban (HTTP %d) on Binance. Pausing backfill worker for 60 seconds...", resp.StatusCode)
			time.Sleep(60 * time.Second)
			continue
		}

		if resp.StatusCode != 200 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			return all, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
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
			if len(k) < 8 {
				continue
			}
			timestamp, ok := k[0].(float64)
			if !ok || timestamp <= 0 {
				continue
			}
			// Persist closed candles only; the stream owns the latest closed bar.
			if int64(timestamp)+60000 > time.Now().UnixMilli() {
				continue
			}
			candle := Candle{
				T: int64(timestamp),
				O: parseF(k[1]), H: parseF(k[2]), L: parseF(k[3]), C: parseF(k[4]), V: parseF(k[7]),
			}
			if validCandle(candle) {
				batch = append(batch, candle)
			}
		}
		if len(batch) == 0 {
			return nil, fmt.Errorf("no valid closed candles in response")
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
			conn.SetReadLimit(2 * 1024 * 1024)

			for {
				conn.SetReadDeadline(time.Now().Add(90 * time.Second))
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
							Q string `json:"q"`
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
					O: parseF(k.O), H: parseF(k.H), L: parseF(k.L), C: parseF(k.C), V: parseF(k.Q),
				}

				ingestClosedCandle(key, newCandle)
			}
			conn.Close()
			time.Sleep(2 * time.Second)
		}
	}()
}

func getTopSymbolsFromNode() ([]string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://127.0.0.1:3000/api/tickers")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
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
		if len(parts) == 2 && parts[0] == "BN" && validSymbol.MatchString(parts[1]) {
			symbols = append(symbols, parts[1])
		}
	}
	return symbols, nil
}

func main() {
	log.Println("=== Starting Go Kline & Scanner Engine ===")

	// Start sequential backfill task queue worker
	startBackfillWorker()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			flushDirtyCandles()
		}
	}()

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
			lastC := list[len(list)-1]
			if !freshHistory(list) {
				log.Printf("[INIT] Disk cache for %s is stale (%v old), queuing fresh backfill", key, time.Since(time.UnixMilli(lastC.T)))
				enqueueBackfill("BN", s)
			} else {
				candlesMu.Lock()
				candlesDB[key] = list
				candlesMu.Unlock()
				log.Printf("[INIT] Pre-loaded %d candles for %s", len(list), key)
			}
		} else {
			enqueueBackfill("BN", s)
		}
	}

	startBinanceWS(symbols)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/klines", klinesHandler)

	// Bind loopback by default: the scanner is an internal backend for the
	// Node server, not a public API. Override with SCANNER_ADDR if needed.
	scannerAddr := os.Getenv("SCANNER_ADDR")
	if scannerAddr == "" {
		scannerAddr = "127.0.0.1:8082"
	}
	log.Println("Go Server listening on " + scannerAddr)
	server := &http.Server{Addr: scannerAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second}
	log.Fatal(server.ListenAndServe())
}
