"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const userStore = require("../userStore");

test("referral attribution is immutable and purchase totals use paid records", async () => {
  const suffix = crypto.randomBytes(6).toString("hex");
  const owner = (await userStore.registerUser({
    username: `Ref${suffix}`, email: `ref_${suffix}@gmail.com`, password: "StrongPassword123!"
  })).user;
  const code = userStore.getReferralCode(owner.id);
  assert.match(code, /^[a-f0-9]{24}$/);
  assert.equal(userStore.recordReferralVisit(code, "203.0.113.10", "test browser"), true);
  assert.equal(userStore.recordReferralVisit(code, "203.0.113.10", "test browser"), true);
  const referred = (await userStore.registerUser({
    username: `Guest${suffix}`, email: `guest_${suffix}@gmail.com`, password: "StrongPassword123!", referralCode: code
  })).user;
  assert.equal(referred.referredBy, owner.id);
  const payments = [
    { userId: referred.id, status: "pending", planId: "1m" },
    { userId: referred.id, status: "success", planId: "3m" },
    { userId: owner.id, status: "success", planId: "12m" }
  ];
  const stats = userStore.getReferralStats(owner.id, payments);
  assert.equal(stats.registrations, 1);
  assert.equal(stats.buyers, 1);
  assert.equal(stats.purchases, 1);
  assert.equal(stats.byPlan["3m"], 1);
  assert.equal(stats.visits, 1);
});
