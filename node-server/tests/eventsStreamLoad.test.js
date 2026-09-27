"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), { EventEmitter } = require("node:events");
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function harness() {
  let handler, notify, unsubscribed = 0;
  const timeouts = new Map(), intervals = new Map(); let next = 0;
  const code = source.slice(source.indexOf("let eventStreamClients ="), source.indexOf("// Formation data is consumed"));
  vm.runInNewContext(code, { app: { get: (_, fn) => { handler = fn; } }, eventsHub: { subscribe(fn) { notify = fn; return () => { unsubscribed++; }; } },
    setTimeout: fn => { const id = ++next; timeouts.set(id, fn); return id; }, clearTimeout: id => timeouts.delete(id),
    setInterval: fn => { const id = ++next; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id) });
  const res = Object.assign(new EventEmitter(), { writableLength: 0, destroyed: false, frames: [], set() {}, flushHeaders() {}, flush() {},
    write(frame) { this.frames.push(frame); }, destroy() { this.destroyed = true; this.emit("close"); } });
  handler({}, res);
  return { res, notify, timeouts, intervals, get unsubscribed() { return unsubscribed; } };
}
test("ten thousand updates coalesce while urgent alerts are delivered immediately", () => {
  const h = harness();
  for (let i = 0; i < 10000; i++) h.notify();
  assert.equal(h.timeouts.size, 1);
  h.notify({ type: "urgent", item: { id: "incident", title: "Incident" } });
  assert.equal(h.res.frames.length, 2); assert.match(h.res.frames[1], /event: urgent/);
  for (const fn of h.timeouts.values()) fn();
  assert.equal(h.res.frames.filter(frame => frame.includes("event: update")).length, 1);
  h.res.destroy();
});
test("a stalled stream releases subscription and both timers exactly once", () => {
  const h = harness();
  h.notify(); h.res.writableLength = 65536;
  h.notify({ type: "urgent", item: { title: "Incident" } });
  assert.equal(h.res.destroyed, true);
  assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
  h.res.emit("close"); assert.equal(h.unsubscribed, 1);
});
