"use strict";

function createSlidingWindowLimiter({ windowMs, max, key }) {
  const buckets = new Map();
  let calls = 0;
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const bucketKey = String(key(req) || "unknown").slice(0, 256);
    const cutoff = now - windowMs;
    const recent = (buckets.get(bucketKey) || []).filter(timestamp => timestamp > cutoff);
    if (recent.length >= max) {
      res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "Слишком много запросов. Повторите попытку позднее.", code: "RATE_LIMITED" });
    }
    recent.push(now);
    buckets.set(bucketKey, recent);
    calls++;
    if (calls % 500 === 0) {
      for (const [candidate, timestamps] of buckets) {
        const alive = timestamps.filter(timestamp => timestamp > cutoff);
        if (alive.length) buckets.set(candidate, alive);
        else buckets.delete(candidate);
      }
    }
    next();
  };
}

function getBearerToken(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{40,256})$/i.exec(authorization.trim());
  return match ? match[1] : "";
}

function registerPaymentRoutes(app, { userStore, paymentGateway }) {
  if (!app || !userStore || !paymentGateway) throw new Error("Payment routes require app, userStore and paymentGateway");

  const createIpLimit = createSlidingWindowLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    key: req => req.ip
  });
  const createUserLimit = createSlidingWindowLimiter({
    windowMs: 10 * 60 * 1000,
    max: 6,
    key: req => req.authUser && req.authUser.id
  });
  const statusLimit = createSlidingWindowLimiter({
    windowMs: 60 * 1000,
    max: 180,
    key: req => `${req.ip}:${req.authUser && req.authUser.id}`
  });
  const webhookLimit = createSlidingWindowLimiter({
    windowMs: 60 * 1000,
    max: 180,
    key: req => req.ip
  });

  function paymentHeaders(_req, res, next) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }

  function authenticate(req, res, next) {
    const user = userStore.getUserByToken(getBearerToken(req));
    if (!user) return res.status(401).json({ error: "Необходима авторизация.", code: "UNAUTHORIZED" });
    req.authUser = user;
    next();
  }

  function sendError(res, error) {
    if (error && error.expose) {
      return res.status(error.status || 400).json({ error: error.message, code: error.code || "PAYMENT_ERROR" });
    }
    console.error("[PAYMENT API] Request failed:", error && error.message ? error.message : "unknown error");
    return res.status(500).json({ error: "Внутренняя ошибка платёжной системы.", code: "INTERNAL_ERROR" });
  }

  app.get("/api/pay/config", paymentHeaders, (_req, res) => {
    res.json({ ok: true, ...paymentGateway.getPublicConfig() });
  });

  app.post("/api/pay/create", paymentHeaders, createIpLimit, authenticate, createUserLimit, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const planId = typeof body.planId === "string" ? body.planId : "";
      const method = typeof body.method === "string" ? body.method : "";
      const replaceActive = body.replaceActive === true;
      if (planId.length > 32 || method.length > 32) {
        return res.status(400).json({ error: "Некорректные параметры счёта.", code: "INVALID_INPUT" });
      }
      const invoice = await paymentGateway.createInvoice(req.authUser.id, planId, method, { replaceActive });
      res.status(201).json({ ok: true, invoice });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/pay/status/:invoiceId", paymentHeaders, authenticate, statusLimit, async (req, res) => {
    try {
      const result = await paymentGateway.getInvoiceStatus(req.params.invoiceId, req.authUser.id);
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/pay/webhook/cryptobot/:secret", paymentHeaders, webhookLimit, async (req, res) => {
    if (!paymentGateway.verifyWebhookPathSecret(req.params.secret)) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      if (!Buffer.isBuffer(req.rawBody)) {
        return res.status(400).json({ error: "Raw body unavailable" });
      }
      await paymentGateway.handleCryptoBotWebhook(
        req.rawBody,
        req.headers["crypto-pay-api-signature"]
      );
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });
}

module.exports = { registerPaymentRoutes, createSlidingWindowLimiter, getBearerToken };
