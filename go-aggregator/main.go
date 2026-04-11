package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Data types ───────────────────────────────────────────────────────────────

type Ticker struct {
	Key  string  `json:"key"`
	Ex   string  `json:"ex"`
	Sym  string  `json:"sym"`
	Base string  `json:"base"`
	P    float64 `json:"p"`
	Chg  float64 `json:"chg"`
	V    float64 `json:"v"`
	H    float64 `json:"h"`
	L    float64 `json:"l"`
	O    float64 `json:"o"`
	Vlt  float64 `json:"vlt"`
}

type Candle struct {
	T int64   `json:"t"`
	O float64 `json:"o"`
	H float64 `json:"h"`
	L float64 `json:"l"`
	C float64 `json:"c"`
	V float64 `json:"v"`
}

type WsMsg struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// ─── Hub ──────────────────────────────────────────────────────────────────────

type Client struct {
	conn *websocket.Conn
	send chan []byte
	ex   string // "" = all
}

type Hub struct {
	mu      sync.RWMutex
	tickers map[string]*Ticker
	prev    map[string]float64 // key -> last broadcasted price
	clients map[*Client]struct{}
}

var hub = &Hub{
	tickers: make(map[string]*Ticker),
	prev:    make(map[string]float64),
	clients: make(map[*Client]struct{}),
}

func (h *Hub) Set(t *Ticker) {
	h.mu.Lock()
	h.tickers[t.Key] = t
	h.mu.Unlock()
}

func (h *Hub) Snapshot(ex string) []*Ticker {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Ticker, 0, len(h.tickers))
	for _, t := range h.tickers {
		if ex == "" || ex == "ALL" || t.Ex == ex {
			out = append(out, t)
		}
	}
	return out
}

func (h *Hub) AddClient(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) RemoveClient(c *Client) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

// Broadcaster runs every 100ms — sends only changed tickers (diffs)
func (h *Hub) Broadcaster() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		h.mu.RLock()
		var diffs []*Ticker
		for key, t := range h.tickers {
			if prev, ok := h.prev[key]; !ok || prev != t.P {
				diffs = append(diffs, t)
			}
		}
		clients := make([]*Client, 0, len(h.clients))
		for c := range h.clients {
			clients = append(clients, c)
		}
		h.mu.RUnlock()

		if len(diffs) == 0 || len(clients) == 0 {
			continue
		}

		// Update prev prices
		h.mu.Lock()
		for _, t := range diffs {
			h.prev[t.Key] = t.P
		}
		h.mu.Unlock()

		data, _ := json.Marshal(WsMsg{Type: "diff", Data: diffs})
		for _, c := range clients {
			select {
			case c.send <- data:
			default:
			}
		}
	}
}

// ─── WebSocket server ──────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 32768,
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	ex := r.URL.Query().Get("ex")
	client := &Client{conn: conn, send: make(chan []byte, 512), ex: ex}
	hub.AddClient(client)
	defer func() {
		hub.RemoveClient(client)
		conn.Close()
	}()

	// Send snapshot immediately
	snap := hub.Snapshot(ex)
	if data, err := json.Marshal(WsMsg{Type: "snapshot", Data: snap}); err == nil {
		conn.WriteMessage(websocket.TextMessage, data)
	}

	// Write pump
	go func() {
		for data := range client.send {
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		}
	}()

	// Read pump (keep connection alive, handle ping)
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

// ─── REST: tickers snapshot ────────────────────────────────────────────────────

func tickersHandler(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	ex := r.URL.Query().Get("ex")
	snap := hub.Snapshot(ex)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(snap)
}

// ─── REST: klines proxy ────────────────────────────────────────────────────────

var tfBybit = map[string]string{
	"1m": "1", "5m": "5", "15m": "15", "1h": "60",
	"4h": "240", "1d": "D", "3d": "3", "1w": "W",
}
var tfOKX = map[string]string{
	"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H",
	"4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W",
}

func klinesHandler(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	ex := r.URL.Query().Get("ex")
	sym := r.URL.Query().Get("sym")
	tf := r.URL.Query().Get("tf")
	if tf == "" {
		tf = "4h"
	}

	var candles []Candle
	var err error

	switch ex {
	case "BN":
		candles, err = fetchBinanceKlines(sym, tf)
	case "BB":
		candles, err = fetchBybitKlines(sym, tf)
	case "OX":
		candles, err = fetchOKXKlines(sym, tf)
	default:
		candles, err = fetchBinanceKlines(sym, tf)
	}

	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(candles)
}

func fetchBinanceKlines(sym, tf string) ([]Candle, error) {
	url := fmt.Sprintf("https://fapi.binance.com/fapi/v1/klines?symbol=%s&interval=%s&limit=300", sym, tf)
	body, err := httpGet(url)
	if err != nil {
		return nil, err
	}
	var raw [][]interface{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	out := make([]Candle, len(raw))
	for i, k := range raw {
		out[i] = Candle{
			T: int64(k[0].(float64)),
			O: parseF(k[1]), H: parseF(k[2]), L: parseF(k[3]), C: parseF(k[4]), V: parseF(k[5]),
		}
	}
	return out, nil
}

func fetchBybitKlines(sym, tf string) ([]Candle, error) {
	interval, ok := tfBybit[tf]
	if !ok {
		interval = "240"
	}
	url := fmt.Sprintf("https://api.bybit.com/v5/market/kline?category=linear&symbol=%s&interval=%s&limit=300", sym, interval)
	body, err := httpGet(url)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Result struct {
			List [][]string `json:"list"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	list := raw.Result.List
	out := make([]Candle, len(list))
	for i, k := range list {
		idx := len(list) - 1 - i // reverse
		t, _ := strconv.ParseInt(k[0], 10, 64)
		out[idx] = Candle{
			T: t, O: atof(k[1]), H: atof(k[2]), L: atof(k[3]), C: atof(k[4]), V: atof(k[5]),
		}
	}
	return out, nil
}

func fetchOKXKlines(sym, tf string) ([]Candle, error) {
	bar, ok := tfOKX[tf]
	if !ok {
		bar = "4H"
	}
	url := fmt.Sprintf("https://www.okx.com/api/v5/market/candles?instId=%s&bar=%s&limit=300", sym, bar)
	body, err := httpGet(url)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Data [][]string `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	list := raw.Data
	out := make([]Candle, len(list))
	for i, k := range list {
		idx := len(list) - 1 - i // reverse
		t, _ := strconv.ParseInt(k[0], 10, 64)
		out[idx] = Candle{
			T: t, O: atof(k[1]), H: atof(k[2]), L: atof(k[3]), C: atof(k[4]), V: atof(k[5]),
		}
	}
	return out, nil
}

// ─── Binance Futures connector ────────────────────────────────────────────────

func runBinance() {
	for {
		log.Println("[BN] Connecting...")
		conn, _, err := websocket.DefaultDialer.Dial("wss://fstream.binance.com/ws/!miniTicker@arr", nil)
		if err != nil {
			log.Printf("[BN] Dial error: %v — retry in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Println("[BN] Connected")
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[BN] Read error: %v", err)
				break
			}
			var batch []map[string]interface{}
			if err := json.Unmarshal(msg, &batch); err != nil {
				continue
			}
			for _, d := range batch {
				sym, _ := d["s"].(string)
				if !strings.HasSuffix(sym, "USDT") {
					continue
				}
				p := parseF(d["c"])
				o := parseF(d["o"])
				h := parseF(d["h"])
				l := parseF(d["l"])
				vlt := 0.0
				if o > 0 {
					vlt = (h - l) / o * 100
				}
				hub.Set(&Ticker{
					Key:  "BN:" + sym,
					Ex:   "BN",
					Sym:  sym,
					Base: strings.TrimSuffix(sym, "USDT"),
					P:    p,
					Chg:  parseF(d["P"]),
					V:    parseF(d["q"]),
					H:    h,
					L:    l,
					O:    o,
					Vlt:  vlt,
				})
			}
		}
		conn.Close()
		time.Sleep(3 * time.Second)
	}
}

// ─── Bybit Futures connector ──────────────────────────────────────────────────

func runBybit() {
	for {
		// Fetch symbol list
		log.Println("[BB] Fetching symbols...")
		body, err := httpGet("https://api.bybit.com/v5/market/tickers?category=linear")
		if err != nil {
			log.Printf("[BB] REST error: %v — retry in 10s", err)
			time.Sleep(10 * time.Second)
			continue
		}

		var restResp struct {
			Result struct {
				List []struct {
					Symbol       string `json:"symbol"`
					LastPrice    string `json:"lastPrice"`
					Price24hPcnt string `json:"price24hPcnt"`
					Turnover24h  string `json:"turnover24h"`
					HighPrice24h string `json:"highPrice24h"`
					LowPrice24h  string `json:"lowPrice24h"`
					PrevPrice24h string `json:"prevPrice24h"`
				} `json:"list"`
			} `json:"result"`
		}
		if err := json.Unmarshal(body, &restResp); err != nil {
			log.Printf("[BB] Parse error: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}

		var syms []string
		for _, d := range restResp.Result.List {
			if !strings.HasSuffix(d.Symbol, "USDT") {
				continue
			}
			syms = append(syms, d.Symbol)
			p := atof(d.LastPrice)
			o := atof(d.PrevPrice24h)
			h := atof(d.HighPrice24h)
			l := atof(d.LowPrice24h)
			vlt := 0.0
			if o > 0 {
				vlt = (h - l) / o * 100
			}
			hub.Set(&Ticker{
				Key:  "BB:" + d.Symbol,
				Ex:   "BB",
				Sym:  d.Symbol,
				Base: strings.TrimSuffix(d.Symbol, "USDT"),
				P:    p,
				Chg:  atof(d.Price24hPcnt) * 100,
				V:    atof(d.Turnover24h),
				H:    h, L: l, O: o, Vlt: vlt,
			})
		}
		log.Printf("[BB] Loaded %d symbols", len(syms))

		// Connect WebSocket
		conn, _, err := websocket.DefaultDialer.Dial("wss://stream.bybit.com/v5/public/linear", nil)
		if err != nil {
			log.Printf("[BB] WS Dial error: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Println("[BB] WS Connected")

		// Subscribe in batches of 10
		for i := 0; i < len(syms); i += 10 {
			end := i + 10
			if end > len(syms) {
				end = len(syms)
			}
			args := make([]string, end-i)
			for j, s := range syms[i:end] {
				args[j] = "tickers." + s
			}
			msg, _ := json.Marshal(map[string]interface{}{"op": "subscribe", "args": args})
			conn.WriteMessage(websocket.TextMessage, msg)
		}

		// Ping goroutine
		pingStop := make(chan struct{})
		go func() {
			t := time.NewTicker(20 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					conn.WriteMessage(websocket.TextMessage, []byte(`{"op":"ping"}`))
				case <-pingStop:
					return
				}
			}
		}()

		// Read loop
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[BB] Read error: %v", err)
				break
			}
			var d struct {
				Topic string `json:"topic"`
				Data  struct {
					LastPrice    string `json:"lastPrice"`
					Price24hPcnt string `json:"price24hPcnt"`
					Turnover24h  string `json:"turnover24h"`
					HighPrice24h string `json:"highPrice24h"`
					LowPrice24h  string `json:"lowPrice24h"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &d); err != nil || !strings.HasPrefix(d.Topic, "tickers.") {
				continue
			}
			sym := d.Topic[8:]
			if !strings.HasSuffix(sym, "USDT") {
				continue
			}
			key := "BB:" + sym
			hub.mu.RLock()
			existing := hub.tickers[key]
			hub.mu.RUnlock()
			if existing == nil {
				continue
			}
			t := *existing
			if d.Data.LastPrice != "" {
				t.P = atof(d.Data.LastPrice)
			}
			if d.Data.Price24hPcnt != "" {
				t.Chg = atof(d.Data.Price24hPcnt) * 100
			}
			if d.Data.Turnover24h != "" {
				t.V = atof(d.Data.Turnover24h)
			}
			if d.Data.HighPrice24h != "" {
				t.H = atof(d.Data.HighPrice24h)
			}
			if d.Data.LowPrice24h != "" {
				t.L = atof(d.Data.LowPrice24h)
			}
			hub.Set(&t)
		}

		close(pingStop)
		conn.Close()
		time.Sleep(3 * time.Second)
	}
}

// ─── OKX Futures connector ────────────────────────────────────────────────────

func runOKX() {
	for {
		log.Println("[OX] Fetching symbols...")
		body, err := httpGet("https://www.okx.com/api/v5/market/tickers?instType=SWAP")
		if err != nil {
			log.Printf("[OX] REST error: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}

		var restResp struct {
			Data []struct {
				InstId    string `json:"instId"`
				Last      string `json:"last"`
				Open24h   string `json:"open24h"`
				High24h   string `json:"high24h"`
				Low24h    string `json:"low24h"`
				VolCcy24h string `json:"volCcy24h"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &restResp); err != nil {
			log.Printf("[OX] Parse error: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}

		var instIds []string
		for _, d := range restResp.Data {
			if !strings.HasSuffix(d.InstId, "-USDT-SWAP") {
				continue
			}
			instIds = append(instIds, d.InstId)
			p := atof(d.Last)
			o := atof(d.Open24h)
			h := atof(d.High24h)
			l := atof(d.Low24h)
			chg := 0.0
			vlt := 0.0
			if o > 0 {
				chg = (p - o) / o * 100
				vlt = (h - l) / o * 100
			}
			base := strings.TrimSuffix(d.InstId, "-USDT-SWAP")
			hub.Set(&Ticker{
				Key: "OX:" + d.InstId, Ex: "OX", Sym: d.InstId, Base: base,
				P: p, Chg: chg, V: atof(d.VolCcy24h), H: h, L: l, O: o, Vlt: vlt,
			})
		}
		log.Printf("[OX] Loaded %d symbols", len(instIds))

		conn, _, err := websocket.DefaultDialer.Dial("wss://ws.okx.com:8443/ws/v5/public", nil)
		if err != nil {
			log.Printf("[OX] WS Dial error: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}
		log.Println("[OX] WS Connected")

		// Subscribe in batches of 50
		for i := 0; i < len(instIds); i += 50 {
			end := i + 50
			if end > len(instIds) {
				end = len(instIds)
			}
			args := make([]map[string]string, end-i)
			for j, id := range instIds[i:end] {
				args[j] = map[string]string{"channel": "tickers", "instId": id}
			}
			msg, _ := json.Marshal(map[string]interface{}{"op": "subscribe", "args": args})
			conn.WriteMessage(websocket.TextMessage, msg)
		}

		pingStop := make(chan struct{})
		go func() {
			t := time.NewTicker(25 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					conn.WriteMessage(websocket.TextMessage, []byte("ping"))
				case <-pingStop:
					return
				}
			}
		}()

		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[OX] Read error: %v", err)
				break
			}
			if string(msg) == "pong" {
				continue
			}
			var d struct {
				Arg struct {
					Channel string `json:"channel"`
				} `json:"arg"`
				Data []struct {
					InstId    string `json:"instId"`
					Last      string `json:"last"`
					Open24h   string `json:"open24h"`
					High24h   string `json:"high24h"`
					Low24h    string `json:"low24h"`
					VolCcy24h string `json:"volCcy24h"`
				} `json:"data"`
			}
			if err := json.Unmarshal(msg, &d); err != nil || d.Arg.Channel != "tickers" {
				continue
			}
			for _, t := range d.Data {
				if !strings.HasSuffix(t.InstId, "-USDT-SWAP") {
					continue
				}
				key := "OX:" + t.InstId
				hub.mu.RLock()
				existing := hub.tickers[key]
				hub.mu.RUnlock()
				if existing == nil {
					continue
				}
				tk := *existing
				if t.Last != "" {
					tk.P = atof(t.Last)
				}
				if t.Open24h != "" {
					o := atof(t.Open24h)
					tk.O = o
					if o > 0 {
						tk.Chg = (tk.P - o) / o * 100
					}
				}
				if t.High24h != "" {
					tk.H = atof(t.High24h)
				}
				if t.Low24h != "" {
					tk.L = atof(t.Low24h)
				}
				if t.VolCcy24h != "" {
					tk.V = atof(t.VolCcy24h)
				}
				hub.Set(&tk)
			}
		}

		close(pingStop)
		conn.Close()
		time.Sleep(3 * time.Second)
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
}

func httpGet(url string) ([]byte, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func parseF(v interface{}) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		return atof(x)
	}
	return 0
}

func atof(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

// ─── Main ──────────────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("=== CryptoScreen Go Aggregator ===")

	go hub.Broadcaster()
	go runBinance()
	go runBybit()
	go runOKX()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/api/tickers", tickersHandler)
	mux.HandleFunc("/api/klines", klinesHandler)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		hub.mu.RLock()
		n := len(hub.tickers)
		hub.mu.RUnlock()
		fmt.Fprintf(w, `{"status":"ok","tickers":%d}`, n)
	})

	log.Println("Listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
