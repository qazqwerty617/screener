"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createEmailVerification } = require("../emailVerification");

test("registration email code is bound to address, one-use and hidden from response", async () => {
  let message;
  const service = createEmailVerification({ sendMail: async mail => { message = mail; } });
  const challenge = await service.requestCode("trader@example.org");
  const code = /Ваш код подтверждения: (\d{3}) (\d{3})/.exec(message.text);
  assert.ok(code);
  const raw = code[1] + code[2];
  assert.equal(JSON.stringify(challenge).includes(raw), false);
  assert.equal(service.take("wrong@example.org", challenge.challengeId, raw), false);
  assert.ok(service.take("trader@example.org", challenge.challengeId, raw));
  assert.equal(service.take("trader@example.org", challenge.challengeId, raw), false);
});

test("code has limited attempts and resend cooldown", async () => {
  let time = 1000;
  const service = createEmailVerification({ sendMail: async () => {}, now: () => time });
  const { challengeId } = await service.requestCode("trader@example.org");
  await assert.rejects(service.requestCode("trader@example.org"), /через минуту/);
  for (let n = 0; n < 5; n++) assert.equal(service.take("trader@example.org", challengeId, "not-a-code"), false);
  time += 61_000;
  const next = await service.requestCode("trader@example.org");
  assert.notEqual(next.challengeId, challengeId);
  time += 601_000;
  assert.equal(service.take("trader@example.org", next.challengeId, "000000"), false);
});

test("SMTP failure never leaves a usable challenge", async () => {
  const service = createEmailVerification({ sendMail: async () => { throw Error("SMTP offline"); } });
  await assert.rejects(service.requestCode("trader@example.org"), /Не удалось отправить/);
});
