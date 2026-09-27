package main

import (
	"math"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestForeignVenueNeverReceivesBinanceHistory(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/klines?ex=BB&sym=BTCUSDT&tf=1m", nil)
	response := httptest.NewRecorder()
	klinesHandler(response, req)
	if response.Code != 400 {
		t.Fatalf("unsupported venue must be rejected, got %d", response.Code)
	}
}

func sampleCandle(at int64, price float64) Candle {
	return Candle{T: at, O: price, H: price, L: price, C: price, V: 100}
}

func TestGapRecoveryDoesNotDeadlockAndQueuesBackfill(t *testing.T) {
	key := "BN:GAPUSDT"
	now := time.Now().Add(-time.Minute).UnixMilli()
	candlesDB[key] = []Candle{sampleCandle(now-3*60*60*1000, 1)}
	done := make(chan bool, 1)
	go func() { done <- ingestClosedCandle(key, sampleCandle(now, 2)) }()
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("valid closed candle rejected")
		}
	case <-time.After(time.Second):
		t.Fatal("gap recovery deadlocked under candlesMu")
	}
	queuedMu.Lock()
	queued := queuedCoins[key]
	delete(queuedCoins, key)
	queuedMu.Unlock()
	if !queued {
		t.Fatal("history gap was not queued")
	}
	candlesMu.Lock()
	delete(candlesDB, key)
	delete(diskDirty, key)
	candlesMu.Unlock()
}

func TestBackfillPreservesLiveTailAndRejectsOutOfOrderStream(t *testing.T) {
	key := "BN:LIVEUSDT"
	now := time.Now().Add(-time.Minute).UnixMilli()
	if !ingestClosedCandle(key, sampleCandle(now, 3)) {
		t.Fatal("rejected valid candle")
	}
	mergeHistory(key, []Candle{sampleCandle(now-60000, 1), sampleCandle(now, 2)})
	if candlesDB[key][1].C != 3 {
		t.Fatal("REST overwrote newer live data")
	}
	if ingestClosedCandle(key, sampleCandle(now-60000, 9)) {
		t.Fatal("accepted out-of-order candle")
	}
	delete(candlesDB, key)
	delete(diskDirty, key)
}

func TestConcurrentReadersAndUpdates(t *testing.T) {
	key := "BN:CONCURRENTUSDT"
	now := time.Now().Add(-time.Minute).UnixMilli()
	mergeHistory(key, []Candle{sampleCandle(now-60000, 1), sampleCandle(now, 2)})
	var group sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for i := 0; i < 100; i++ {
				ingestClosedCandle(key, sampleCandle(now, 2+float64(i)))
				res := httptest.NewRecorder()
				klinesHandler(res, httptest.NewRequest("GET", "/api/klines?ex=BN&sym=CONCURRENTUSDT&tf=1m", nil))
				if res.Code != 200 {
					t.Errorf("request failed: %d", res.Code)
				}
			}
		}()
	}
	group.Wait()
	delete(candlesDB, key)
	delete(diskDirty, key)
}

func TestCoalescedDiskSaveRoundTripsLatestSnapshot(t *testing.T) {
	previousDir := dataDir
	dataDir = t.TempDir()
	defer func() { dataDir = previousDir }()
	key := "BN:SAVEUSDT"
	now := time.Now().Add(-time.Minute).UnixMilli()
	ingestClosedCandle(key, sampleCandle(now, 1))
	ingestClosedCandle(key, sampleCandle(now, 2))
	flushDirtyCandles()
	list, err := loadCandlesFromDisk(key)
	if err != nil || len(list) != 1 || list[0].C != 2 {
		t.Fatalf("invalid saved snapshot: %v %v", list, err)
	}
	delete(candlesDB, key)
}

func TestCorruptDiskCandleCannotReachChart(t *testing.T) {
	previousDir := dataDir
	dataDir = t.TempDir()
	defer func() { dataDir = previousDir }()
	if err := saveCandlesToDisk("BN:INVALIDUSDT", []Candle{sampleCandle(time.Now().Add(-time.Minute).UnixMilli(), math.NaN())}); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCandlesFromDisk("BN:INVALIDUSDT"); err == nil {
		t.Fatal("invalid prices accepted from disk")
	}
}

func TestStaleMemoryCanQueueRecovery(t *testing.T) {
	key := "BN:STALEUSDT"
	candlesDB[key] = []Candle{{T: time.Now().Add(-3 * time.Hour).UnixMilli(), C: 1}}
	defer delete(candlesDB, key)
	enqueueBackfill("BN", "STALEUSDT")
	queuedMu.Lock()
	queued := queuedCoins[key]
	delete(queuedCoins, key)
	queuedMu.Unlock()
	if !queued {
		t.Fatal("stale cache prevented its own recovery")
	}
}

func TestInvalidSymbolIsRejectedBeforeFilesystemOrNetwork(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/klines?ex=BN&sym=..%2F..%2Fsecret&tf=1m", nil)
	response := httptest.NewRecorder()
	klinesHandler(response, req)
	if response.Code != 400 || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("bad symbol accepted: %d", response.Code)
	}
}

func TestShortGapCannotBeServedAsCompleteHistory(t *testing.T) {
	key := "BN:SHORTGAPUSDT"
	now := time.Now().Add(-time.Minute).UnixMilli()
	candlesDB[key] = []Candle{sampleCandle(now-3*60000, 1)}
	defer delete(candlesDB, key)
	defer delete(diskDirty, key)
	ingestClosedCandle(key, sampleCandle(now, 2))
	res := httptest.NewRecorder()
	klinesHandler(res, httptest.NewRequest("GET", "/api/klines?ex=BN&sym=SHORTGAPUSDT&tf=1m", nil))
	if res.Code != 202 {
		t.Fatalf("incomplete history served as complete: %d", res.Code)
	}
	mergeHistory(key, []Candle{sampleCandle(now-2*60000, 1), sampleCandle(now-60000, 1)})
	if !freshHistory(candlesDB[key]) {
		t.Fatal("filled gap is still considered stale")
	}
}
