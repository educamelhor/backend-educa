// =============================================================================
// services/cameraCapture.js
// =============================================================================
// PASSO 4.1 — Captura de frame via FFmpeg (RTSP → JPG)
//
// Responsabilidade:
// - Executar FFmpeg via child_process
// - Capturar 1 frame sob demanda
// - NÃO possui lógica de câmera, overlay ou visão computacional
//
// Pipeline:
// RTSP → FFmpeg → frame.jpg
// =============================================================================

import { spawn } from "child_process";
import path from "path";
import fs from "fs";

// ----------------------------------------------------------------------------
// Função principal
// ----------------------------------------------------------------------------
export function captureFrame({ rtspUrl, outputPath, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const makeErr = (code, message, meta = null) => {
      const e = new Error(message);
      e.code = code;
      if (meta) e.meta = meta;
      return e;
    };

    const classifyStderr = (stderr = "") => {
      const s = String(stderr || "").toLowerCase();

      // RTSP/Auth
      if (s.includes("401 unauthorized") || s.includes("unauthorized")) return "RTSP_AUTH_FAIL";
      if (s.includes("404 not found")) return "RTSP_NOT_FOUND";

      // Rede/conexão
      if (s.includes("connection refused")) return "RTSP_CONN_REFUSED";
      if (s.includes("no route to host")) return "RTSP_NO_ROUTE";
      if (s.includes("network is unreachable")) return "RTSP_NETWORK_UNREACHABLE";
      if (s.includes("timed out") || s.includes("timeout")) return "RTSP_TIMEOUT";

      // Stream inválida / indisponível
      if (s.includes("could not find codec parameters")) return "RTSP_STREAM_INVALID";
      if (s.includes("invalid data found when processing input")) return "RTSP_INVALID_DATA";

      return "FFMPEG_EXIT_NONZERO";
    };

    if (!rtspUrl) {
      return reject(makeErr("CAPTURE_BAD_INPUT", "rtspUrl é obrigatório"));
    }

    if (!outputPath) {
      return reject(makeErr("CAPTURE_BAD_INPUT", "outputPath é obrigatório"));
    }

    // Garante diretório
    const dir = path.dirname(outputPath);
    fs.mkdirSync(dir, { recursive: true });

    // Remove arquivo antigo (se existir)
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    // Monta argumentos do FFmpeg
    const args = [
      "-y",                 // sobrescreve arquivo
      "-rtsp_transport", "tcp",
      "-i", rtspUrl,
      "-frames:v", "1",     // apenas 1 frame
      "-q:v", "2",          // qualidade alta
      outputPath,
    ];

    console.log("[cameraCapture] FFmpeg start:", {
      outputPath,
      timeoutMs,
      // NÃO logar rtspUrl (segredo)
      // NÃO logar args completos (contêm rtspUrl)
    });

    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"], // só stderr interessa
    });

    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {}
        return reject(makeErr("FFMPEG_TIMEOUT", "Timeout ao capturar frame via FFmpeg", { timeoutMs }));
      }
    }, timeoutMs);

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("error", (err) => {
      clearTimeout(timer);
      return reject(makeErr("FFMPEG_SPAWN_FAIL", err?.message || "Falha ao iniciar FFmpeg"));
    });

    ffmpeg.on("close", (code) => {
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        const errCode = classifyStderr(stderr);
        return reject(
          makeErr(
            errCode,
            `Falha FFmpeg (code=${code})`,
            {
              exitCode: code,
              // stderr pode conter caminhos/infos, mas não deve conter RTSP (rtspUrl não está no stderr normalmente)
              stderrPreview: String(stderr || "").slice(0, 900),
            }
          )
        );
      }

      if (!fs.existsSync(outputPath)) {
        return reject(makeErr("FRAME_NOT_GENERATED", "FFmpeg finalizou, mas o frame não foi gerado"));
      }

      let stats;
      try {
        stats = fs.statSync(outputPath);
      } catch (e) {
        return reject(makeErr("FS_STAT_FAIL", e?.message || "Falha ao ler stats do arquivo de frame"));
      }

      resolve({
        ok: true,
        outputPath,
        sizeBytes: stats.size,
      });
    });
  });
}
