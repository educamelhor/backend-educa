import bcrypt from "bcryptjs";

/**
 * Middleware: autenticarDeviceCapture
 *
 * Padrão:
 *  - Authorization: Device <device_token>
 *  - x-device-uid: <device_uid>   (ou device_uid no body)
 *
 * Valida:
 *  - device_uid existe e está ATIVO
 *  - bcrypt.compare(device_token, device_secret_hash) === true
 *
 * Side effects:
 *  - atualiza capture_devices.last_seen_at = NOW()
 *  - injeta req.captureDevice
 */
export async function autenticarDeviceCapture(req, res, next) {
  try {
    const auth = String(req.headers?.authorization || "").trim();

    if (!auth.toLowerCase().startsWith("device ")) {
      return res.status(401).json({
        ok: false,
        message: "Authorization inválido. Use: Authorization: Device <device_token>",
      });
    }

    const deviceToken = auth.slice("device ".length).trim();

    // device_uid: preferir header, fallback body (mas bloquear conflito)
    const deviceUidHeader = String(req.headers?.["x-device-uid"] || "").trim();
    const deviceUidBody = String(req.body?.device_uid || "").trim();

    if (deviceUidHeader && deviceUidBody && deviceUidHeader.trim().toUpperCase() !== deviceUidBody.trim().toUpperCase()) {
      return res.status(400).json({
        ok: false,
        message: "Conflito: device_uid no body difere do header. Envie apenas um, ou valores idênticos.",
      });
    }

    const device_uid_raw = deviceUidHeader || deviceUidBody;

    // PASSO 4 — Validação estrutural do UID (hardening)
    const device_uid = String(device_uid_raw || "").trim().toUpperCase();
    const UID_MIN = 8;
    const UID_MAX = 64;
    const UID_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

    if (!device_uid || device_uid.length < UID_MIN || device_uid.length > UID_MAX || !UID_RE.test(device_uid)) {
      return res.status(400).json({
        ok: false,
        message: `device_uid inválido. Use ${UID_MIN}-${UID_MAX} chars, apenas A-Z, 0-9, _ ou - (ex: TAB_SEC_001).`,
      });
    }

    // PASSO 5 — Hardening do token: formato estrito (32 bytes -> hex 64)
    const TOKEN_RE = /^[a-f0-9]{64}$/i;

    if (!deviceToken || !TOKEN_RE.test(deviceToken)) {
      return res.status(401).json({
        ok: false,
        message: "device_token ausente ou inválido.",
      });
    }

    // (PASSO 4) validação estrutural já aplicada acima — mantém este bloco como redundância defensiva
    if (!device_uid) {
      return res.status(400).json({
        ok: false,
        message: "device_uid obrigatório (envie em x-device-uid ou no body).",
      });
    }

    // Usa pool já injetado no app (server.js faz req.db = pool)
    const db = req.db;
    if (!db) {
      return res.status(500).json({ ok: false, message: "DB não disponível no request." });
    }

    const [rows] = await db.query(
      `
      SELECT id, escola_id, device_uid, device_secret_hash, ativo
        FROM capture_devices
       WHERE device_uid = ?
       LIMIT 1
      `,
      [device_uid]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ ok: false, message: "Dispositivo não encontrado." });
    }

    const device = rows[0];

    if (!device.ativo) {
      return res.status(401).json({ ok: false, message: "Dispositivo revogado/inativo." });
    }

    const ok = await bcrypt.compare(deviceToken, String(device.device_secret_hash || ""));
    if (!ok) {
      return res.status(401).json({ ok: false, message: "device_token inválido." });
    }

    // Atualiza last_seen_at
    await db.query(`UPDATE capture_devices SET last_seen_at = NOW() WHERE id = ?`, [device.id]);

    // Injeta contexto do device no request
    req.captureDevice = {
      id: Number(device.id),
      escola_id: Number(device.escola_id),
      device_uid: String(device.device_uid),
    };

    return next();
  } catch (err) {
    const code = err?.code;
    const msg = String(err?.message || err || "");

    const isConnReset = code === "ECONNRESET" || msg.includes("ECONNRESET");
    const isTimeout = code === "ETIMEDOUT" || msg.includes("ETIMEDOUT");
    const isPipe = code === "EPIPE" || msg.includes("EPIPE");

    // Se o cliente abortou ou a conexão caiu, não faz sentido "gritar" no log nem tentar responder
    if (req?.aborted || res?.writableEnded || res?.headersSent) {
      if (isConnReset || isTimeout || isPipe) {
        console.warn("[CAPTURE] autenticarDeviceCapture: request aborted/network issue:", code || msg);
      } else {
        console.warn("[CAPTURE] autenticarDeviceCapture: request aborted:", code || msg);
      }
      return;
    }

    // Erros de rede/intermitência → resposta consistente (sem vazar detalhes)
    if (isConnReset || isTimeout || isPipe) {
      console.warn("[CAPTURE] autenticarDeviceCapture: network issue:", code || msg);
      return res
        .status(503)
        .json({ ok: false, message: "Falha temporária na comunicação. Tente novamente." });
    }

    console.error("[CAPTURE] autenticarDeviceCapture erro:", msg);
    return res.status(500).json({ ok: false, message: "Erro interno na autenticação do dispositivo." });
  }
}
