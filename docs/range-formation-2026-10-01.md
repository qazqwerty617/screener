# Range / Боковик

Range is an active horizontal price box with confirmed, alternating visits to
support and resistance. The shared `formationEngine` supplies the server scanner,
browser chart overlays and alert geometry; it makes no extra exchange requests.

- At least two confirmed pivot visits on **each** boundary. Consecutive candles
  touching the same side count as one visit; unconfirmed live pivots do not count.
- Adaptive boundary tolerance, a minimum width of three ATRs / 0.2% of price,
  at least 18 bars between first and last visit and no major wick or closing
  breakout since the first retained visit. Drifting boundaries are excluded.
- Incomplete, unordered or malformed history cannot certify a range. Tiny token
  prices retain their full precision.
- Work is bounded to 400 recent bars, six clusters per side and one dominant box
  per market. Short-lived ranges, weak/noisy boxes and older historical ranges
  are intentionally excluded. This is a deterministic pattern detector, not
  evidence that every future bounce will hold or a profitability estimate.

The Formations selector and main chart overlay expose Range. Charts draw two
coloured boundaries, a shaded box, touch marks and width as a percentage of the
midpoint. The workspace minimum applies separately to each side. Distance means
distance from the current price to the nearest boundary.

Range alerts are **off by default**, including on old accounts. Their own
timeframes, per-side minimum and distance settings combine with the existing
exchange, volume, blacklist and cooldown filters. Both browser and Telegram
gates recheck the live price inside both boundaries. Telegram snapshots show
both lines and their touch points. No messages were sent during testing.

Validation: 935 Node tests passed, including 23 additional cases for Range,
invalid history, live breakouts, tiny prices, 20,000-bar histories, server
snapshots, workspace filters, account restoration and browser/Telegram gates.
The local browser fixture displayed the real range chart with both boundaries
and touch markers in English. Exchange scanner coverage and update cadence
remain the existing scanner's limits; adding Range does not extend them.
