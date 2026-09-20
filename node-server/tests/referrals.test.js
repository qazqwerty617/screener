"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const userStore = require("../userStore");

test("profile keeps referral statistics and manual reward rules behind a compact disclosure", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../public/css/app.css"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  const document = new JSDOM(html).window.document;
  const details = document.getElementById("profile-referral-section");
  assert.equal(details.tagName, "DETAILS");
  assert.equal(details.open, false);
  assert.ok(details.querySelector("summary"));
  for (const key of ["visits", "registrations", "buyers", "purchases", "1m", "3m", "12m", "lifetime"]) {
    assert.ok(details.querySelector(`[data-ref-stat="${key}"]`));
  }
  assert.match(details.textContent, /50 уникальных переходов/);
  assert.match(details.textContent, /1,5 месяца PRO/);
  assert.match(details.textContent, /Награды не начисляются автоматически/);
  assert.equal(details.querySelector('.profile-referral-rewards a').href, "https://t.me/ObsidianSup");
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*?\.profile-referral-body\s*\{[\s\S]*?position: fixed/);
  assert.match(client, /function placeReferralPopover\(\)/);
  assert.match(client, /window\.setTimeout\([\s\S]*?\}, 500\)/);
  assert.match(client, /referralPopoverPanel\?\.addEventListener\("mouseenter", clearReferralHoverTimer\)/);
  assert.match(client, /function closeReferralPopoverSoon\(\)/);
});

test("referral attribution is immutable and purchase totals use paid records", async () => {
  const suffix = crypto.randomBytes(6).toString("hex");
  const owner = (await userStore.registerUser({
    username: `Ref${suffix}`, email: `ref_${suffix}@gmail.com`, password: "StrongPassword123!", ip: "203.0.113.1"
  })).user;
  const code = userStore.getReferralCode(owner.id);
  assert.match(code, /^[a-f0-9]{24}$/);
  assert.equal(userStore.recordReferralVisit(code, "203.0.113.10", "test browser"), true);
  assert.equal(userStore.recordReferralVisit(code, "203.0.113.10", "test browser"), true);
  const referred = (await userStore.registerUser({
    username: `Guest${suffix}`, email: `guest_${suffix}@gmail.com`, password: "StrongPassword123!", referralCode: code, ip: "203.0.113.10"
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
  assert.equal(stats.eligibleVisits, 1);
});

test("referral visits and signups from the same source cannot be farmed", async () => {
  const suffix = crypto.randomBytes(6).toString("hex");
  const owner = (await userStore.registerUser({
    username: `Owner${suffix}`, email: `owner_${suffix}@gmail.com`, password: "StrongPassword123!", ip: "198.51.100.41"
  })).user;
  const code = userStore.getReferralCode(owner.id);
  userStore.recordReferralVisit(code, "198.51.100.41", "owner browser", owner.id);
  userStore.recordReferralVisit(code, "198.51.100.42", "browser A");
  userStore.recordReferralVisit(code, "198.51.100.42", "browser B");
  userStore.recordReferralVisit(code, "198.51.100.42", "new account browser");

  const sameSource = (await userStore.registerUser({
    username: `GuestA${suffix}`, email: `guesta_${suffix}@gmail.com`, password: "StrongPassword123!", referralCode: code, ip: "198.51.100.42"
  })).user;
  const duplicate = (await userStore.registerUser({
    username: `GuestB${suffix}`, email: `guestb_${suffix}@gmail.com`, password: "StrongPassword123!", referralCode: code, ip: "198.51.100.42"
  })).user;
  const selfSource = (await userStore.registerUser({
    username: `GuestC${suffix}`, email: `guestc_${suffix}@gmail.com`, password: "StrongPassword123!", referralCode: code, ip: "198.51.100.41"
  })).user;

  assert.equal(sameSource.referredBy, owner.id);
  assert.equal(duplicate.referredBy, undefined);
  assert.equal(selfSource.referredBy, undefined);
  assert.equal(sameSource.referralSourceKey, undefined);
  const stats = userStore.getReferralStats(owner.id, [
    { userId: sameSource.id, status: "success", planId: "1m" },
    { userId: duplicate.id, status: "success", planId: "12m" }
  ]);
  assert.equal(stats.visits, 1);
  assert.equal(stats.eligibleVisits, 1);
  assert.equal(stats.registrations, 1);
  assert.equal(stats.buyers, 1);
  assert.equal(stats.purchases, 1);
});

test("admin partner links keep an immutable click-to-payment funnel separate from referrals", async () => {
  const suffix = crypto.randomBytes(6).toString("hex");
  const partner = userStore.createPartner({
    name: `Partner ${suffix}`, contact: "@partner", label: "test campaign", createdBy: "test"
  });
  assert.match(partner.id, /^PTN-[a-f0-9]{12}$/);
  assert.match(partner.code, /^p_[A-Za-z0-9_-]{16}$/);
  assert.equal(userStore.recordPartnerVisit(partner.code, "203.0.113.71", "browser one"), true);
  assert.equal(userStore.recordPartnerVisit(partner.code, "203.0.113.71", "browser two"), true);
  assert.equal(userStore.recordPartnerVisit(partner.code, "203.0.113.72", "browser three"), true);

  const first = (await userStore.registerUser({
    username: `PartnerLead${suffix}`, email: `partner_lead_${suffix}@gmail.com`, password: "StrongPassword123!", referralCode: partner.code, ip: "203.0.113.71"
  })).user;
  const duplicate = (await userStore.registerUser({
    username: `PartnerDup${suffix}`, email: `partner_dup_${suffix}@gmail.com`, password: "StrongPassword123!", referralCode: partner.code, ip: "203.0.113.71"
  })).user;
  assert.equal(first.partnerLinkId, partner.id);
  assert.equal(duplicate.partnerLinkId, undefined, "one source cannot create multiple attributed leads");

  const stats = userStore.getPartnerStats(partner.id, [
    { userId: first.id, status: "success", planId: "3m", amount: 79 },
    { userId: first.id, status: "success", planId: "12m", amount: 199 },
    { userId: duplicate.id, status: "success", planId: "1m", amount: 29 }
  ]);
  assert.equal(stats.clicks, 3);
  assert.equal(stats.visits, 2);
  assert.equal(stats.eligibleVisits, 2);
  assert.equal(stats.registrations, 1);
  assert.equal(stats.buyers, 1);
  assert.equal(stats.purchases, 2);
  assert.equal(stats.revenue, 278);
  assert.equal(stats.byPlan["3m"], 1);
  assert.equal(stats.byPlan["12m"], 1);

  userStore.setPartnerStatus(partner.id, "paused");
  assert.equal(userStore.recordPartnerVisit(partner.code, "203.0.113.73", "paused"), false);
});
