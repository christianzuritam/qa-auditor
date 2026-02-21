require("dotenv").config({ override: true });
const cors = require("cors");
const express = require("express");
const multer = require("multer");

const app = express();

const allowedOrigins = new Set([
  "https://qa.christianzurita.com",
  "https://www.qa.christianzurita.com",
  "https://qa-auditor-app.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

app.use(
  cors({
    origin(origin, callback) {
      // Permite herramientas sin header Origin (curl, health checks).
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`Origen no permitido por CORS: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
  })
);
const port = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
const anthropicFallbackModels = [
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "claude-3-5-sonnet-20241022",
  "claude-3-haiku-20240307"
];

app.use(express.static("public"));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "qa-auditor-api",
    ts: new Date().toISOString()
  });
});

function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_e) {
    const sanitized = text
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\r\n\t]/g, " ")
      .trim();
    return JSON.parse(sanitized);
  }
}

function parseJsonFromModelOutput(outputText) {
  if (!outputText || typeof outputText !== "string") {
    throw new Error("La IA no devolvio texto utilizable");
  }

  const cleaned = outputText
    .replace(/^\uFEFF/, "")
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .replace(/^json\s*/i, "")
    .replace(/[\u0000-\u0019]+/g, " ")
    .trim();
  const fencedMatch = cleaned.match(/\{[\s\S]*\}/);
  const candidate = (fencedMatch?.[0] || cleaned).replace(/^json\s*/i, "").trim();

  try {
    return parseLooseJson(candidate);
  } catch (_e) {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = candidate.slice(firstBrace, lastBrace + 1);
      return parseLooseJson(sliced);
    }
    throw new Error("No se pudo parsear JSON desde la respuesta del modelo");
  }
}

function extractAnthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("\n")
    .trim();
}

function sugerirAccion(estado, campo) {
  if (estado === "correcto") return `Sin cambios en ${campo}.`;
  if (estado === "no_visible") return `Validar y documentar ${campo} en ambas capturas para auditoría.`;
  return `Ajustar ${campo} en plataforma para que coincida con Happy Fox.`;
}

function normalizarCampo(item = {}) {
  const estado = item.estado || "no_visible";
  const campo = item.campo || "campo_sin_nombre";
  const detalle = item.detalle || "";

  return {
    campo,
    estado,
    happyfox: item.happyfox || item.happyFox || "No especificado claramente en la respuesta.",
    plataforma: item.plataforma || "No especificado claramente en la respuesta.",
    diferencia: item.diferencia || detalle || "Sin detalle de diferencia.",
    accion: item.accion || sugerirAccion(estado, campo)
  };
}

function recoverPartialResultFromText(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const cleaned = rawText
    .replace(/^json\s*/i, "")
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .replace(/[\u0000-\u0019]+/g, " ")
    .trim();

  const resumenMatch = cleaned.match(/"resumen"\s*:\s*"([\s\S]*?)"\s*,\s*"aprobado"/i);
  const aprobadoMatch = cleaned.match(/"aprobado"\s*:\s*(true|false)/i);
  const camposSectionMatch = cleaned.match(/"campos"\s*:\s*\[([\s\S]*)/i);
  const camposRawSection = camposSectionMatch?.[1] || "";
  const objectMatches = camposRawSection.match(/\{[\s\S]*?\}(?=\s*,|\s*\])/g) || [];

  const recoveredCampos = objectMatches
    .map((chunk) => {
      try {
        return parseLooseJson(chunk);
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean)
    .map(normalizarCampo);

  if (!recoveredCampos.length) return null;

  return {
    resumen:
      (resumenMatch?.[1] || "Resultado recuperado parcialmente por truncamiento de respuesta.").replace(/\\"/g, '"'),
    aprobado: aprobadoMatch?.[1] === "true",
    campos: recoveredCampos,
    alertas: ["Respuesta de IA truncada. Se muestran los campos recuperados parcialmente."]
  };
}

async function fetchAvailableAnthropicModels(apiKey) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    });
    if (!response.ok) return [];
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) return [];
    return payload.data
      .map((m) => m?.id)
      .filter((id) => typeof id === "string" && id.toLowerCase().includes("claude"));
  } catch (_e) {
    return [];
  }
}

app.post(
  "/api/auditar",
  upload.fields([
    { name: "happyFox", maxCount: 1 },
    { name: "plataforma", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "tu_claude_api_key_aqui") {
        return res.status(500).json({
          ok: false,
          error: "ANTHROPIC_API_KEY no es valida o no esta configurada en .env"
        });
      }

      const happyFoxFile = req.files?.happyFox?.[0];
      const plataformaFile = req.files?.plataforma?.[0];

      if (!happyFoxFile || !plataformaFile) {
        return res.status(400).json({
          ok: false,
          error: "Debes cargar ambas imágenes para auditar"
        });
      }

      const plataformaNombre = (req.body?.plataformaNombre || "No especificada").trim();

      const promptText = `Compara la imagen de Happy Fox con la imagen de plataforma (${plataformaNombre}).
Evalúa al menos: segmentación, inversión/presupuesto, fechas, objetivo de campaña, audiencias, geografía, ubicaciones y creatividad/formato.

Reglas:
- Happy Fox es la fuente de verdad (base de validación).
- La imagen de plataforma (${plataformaNombre}) se valida contra Happy Fox.
- Escribe en español claro para planners/traffickers.
- Responde SOLO JSON valido, sin markdown, sin bloque \`\`\`.
- Debes devolver EXACTAMENTE estos 8 campos en \"campos\" y en este orden:
  1) segmentación
  2) inversión/presupuesto
  3) fechas
  4) objetivo de campaña
  5) audiencias
  6) geografía
  7) ubicaciones
  8) creatividad/formato
- No agregues campos extra.
- Cada valor de \"happyfox\", \"plataforma\", \"diferencia\" y \"accion\" debe ser breve (máximo 20 palabras).
- \"alertas\" máximo 3 elementos, cada uno máximo 16 palabras.
- Devuelve SOLO JSON con esta estructura exacta:
{
  "resumen": string,
  "aprobado": boolean,
  "campos": [
    {
      "campo": string,
      "estado": "correcto" | "diferencia" | "no_visible",
      "happyfox": string,
      "plataforma": string,
      "diferencia": string,
      "accion": string
    }
  ],
  "alertas": string[]
}`;

      const discoveredModels = await fetchAvailableAnthropicModels(process.env.ANTHROPIC_API_KEY);
      const modelCandidates = [...new Set([anthropicModel, ...anthropicFallbackModels, ...discoveredModels])];
      let apiPayload = null;
      let lastError = "";
      const modelErrors = [];

      for (const modelCandidate of modelCandidates) {
        const anthropicBody = {
          model: modelCandidate,
          max_tokens: 4096,
          temperature: 0,
          system:
            "Eres auditor de pauta digital para una central de medios. Compara pedido vs configuración real sin inventar. Debes escribir hallazgos claros para equipo operativo y responder solo JSON.",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptText },
                { type: "text", text: "Imagen 1: Solicitud en Happy Fox" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: happyFoxFile.mimetype,
                    data: happyFoxFile.buffer.toString("base64")
                  }
                },
                { type: "text", text: "Imagen 2: Configuración en plataforma" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: plataformaFile.mimetype,
                    data: plataformaFile.buffer.toString("base64")
                  }
                }
              ]
            }
          ]
        };

        let response;
        try {
          response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": process.env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json"
            },
            body: JSON.stringify(anthropicBody)
          });
        } catch (networkError) {
          const code = networkError?.cause?.code || networkError?.code || "NETWORK_ERROR";
          const message = networkError?.cause?.message || networkError?.message || "Sin detalle de red";
          throw new Error(`No se pudo conectar con Anthropic (${code}): ${message}`);
        }

        const payload = await response.json();
        if (response.ok) {
          apiPayload = payload;
          break;
        }

        const errorText = payload?.error?.message || payload?.error?.type || "Error Anthropic API";
        lastError = errorText;
        modelErrors.push(`${modelCandidate}: ${errorText}`);
        const maybeModelError =
          /model/i.test(errorText) || payload?.error?.type === "not_found_error" || payload?.error?.type === "invalid_request_error";
        if (!maybeModelError) {
          throw new Error(errorText);
        }
      }

      if (!apiPayload) {
        const joined = modelErrors.length ? ` | Intentos: ${modelErrors.join(" || ")}` : "";
        throw new Error((lastError || "No se pudo usar ninguno de los modelos configurados") + joined);
      }

      let parsed;
      const completionText = extractAnthropicText(apiPayload?.content);
      try {
        parsed = parseJsonFromModelOutput(completionText);
      } catch (_e) {
        const recovered = recoverPartialResultFromText(completionText);
        parsed =
          recovered ||
          {
            resumen: "No se pudo parsear JSON de salida, revisa respuesta cruda.",
            aprobado: false,
            campos: [],
            alertas: [completionText || "Sin respuesta del modelo"]
          };
      }

      parsed = {
        resumen: parsed?.resumen || "Sin resumen",
        aprobado: Boolean(parsed?.aprobado),
        campos: Array.isArray(parsed?.campos) ? parsed.campos.map(normalizarCampo) : [],
        alertas: Array.isArray(parsed?.alertas) ? parsed.alertas : []
      };

      return res.json({ ok: true, resultado: parsed });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: "Error al auditar imágenes con IA",
        detalle: error?.message || "Error desconocido"
      });
    }
  }
);

app.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
  console.log(`Modelo Anthropic activo: ${anthropicModel}`);
});
