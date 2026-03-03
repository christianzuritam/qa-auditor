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
app.use(express.json({ limit: "2mb" }));
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
const openAIModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
const openAIFallbackModels = ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"];
const requiredFieldOrder = [
  "segmentación",
  "inversión/presupuesto",
  "fechas",
  "objetivo de campaña",
  "audiencias",
  "geografía",
  "ubicaciones",
  "creatividad/formato"
];

function normalizarProveedorIA(value = "") {
  const raw = String(value || "")
    .toLowerCase()
    .trim();
  if (raw.includes("openai")) return "openai";
  return "claude";
}

function etiquetaProveedorIA(provider = "claude") {
  return provider === "openai" ? "OpenAI" : "Claude";
}

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

function normalizarNombreCampo(campo = "") {
  return String(campo || "")
    .toLowerCase()
    .trim();
}

function alinearCamposObligatorios(camposEntrada = [], camposFallback = []) {
  const campoMap = new Map();

  camposFallback.forEach((item) => {
    const normalized = normalizarCampo(item);
    campoMap.set(normalizarNombreCampo(normalized.campo), normalized);
  });

  camposEntrada.forEach((item) => {
    const normalized = normalizarCampo(item);
    campoMap.set(normalizarNombreCampo(normalized.campo), normalized);
  });

  return requiredFieldOrder.map((campo) => {
    const existing = campoMap.get(normalizarNombreCampo(campo));
    if (existing) {
      return { ...existing, campo };
    }
    return normalizarCampo({
      campo,
      estado: "no_visible",
      happyfox: "No visible en captura de Happy Fox.",
      plataforma: "No visible en captura de plataforma.",
      diferencia: "Sin evidencia suficiente para validar este campo.",
      accion: sugerirAccion("no_visible", campo)
    });
  });
}

function normalizarResultadoAuditoria(data = {}, fallbackData = {}) {
  const camposEntrada = Array.isArray(data?.campos) ? data.campos : [];
  const camposFallback = Array.isArray(fallbackData?.campos) ? fallbackData.campos : [];
  const iaProviderRaw = data?.iaProvider || fallbackData?.iaProvider || "Claude";
  const iaProvider = etiquetaProveedorIA(normalizarProveedorIA(iaProviderRaw));

  return {
    iaProvider,
    resumen: data?.resumen || "Sin resumen",
    aprobado: Boolean(data?.aprobado),
    campos: alinearCamposObligatorios(camposEntrada, camposFallback),
    alertas: Array.isArray(data?.alertas) ? data.alertas.filter((item) => typeof item === "string") : []
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

async function callAnthropicWithFallback({ systemPrompt, messages, maxTokens = 4096, temperature = 0 }) {
  const discoveredModels = await fetchAvailableAnthropicModels(process.env.ANTHROPIC_API_KEY);
  const modelCandidates = [...new Set([anthropicModel, ...anthropicFallbackModels, ...discoveredModels])];

  let lastError = "";
  const modelErrors = [];

  for (const modelCandidate of modelCandidates) {
    const anthropicBody = {
      model: modelCandidate,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages
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

    let payload = {};
    try {
      payload = await response.json();
    } catch (_e) {
      payload = {};
    }

    if (response.ok) {
      return extractAnthropicText(payload?.content);
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

  const joined = modelErrors.length ? ` | Intentos: ${modelErrors.join(" || ")}` : "";
  throw new Error((lastError || "No se pudo usar ninguno de los modelos configurados") + joined);
}

function extractOpenAIText(payload = {}) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload?.output)) {
    const chunks = [];
    payload.output.forEach((item) => {
      if (Array.isArray(item?.content)) {
        item.content.forEach((piece) => {
          if (piece?.type === "output_text" && typeof piece?.text === "string") {
            chunks.push(piece.text);
          } else if (piece?.type === "text" && typeof piece?.text === "string") {
            chunks.push(piece.text);
          }
        });
      }
    });
    const joined = chunks.join("\n").trim();
    if (joined) return joined;
  }

  if (Array.isArray(payload?.choices) && payload.choices[0]?.message?.content) {
    const maybeContent = payload.choices[0].message.content;
    if (typeof maybeContent === "string" && maybeContent.trim()) return maybeContent.trim();
    if (Array.isArray(maybeContent)) {
      const joined = maybeContent
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }

  return "";
}

async function callOpenAIWithFallback({ systemPrompt, userPrompt, images = [], maxTokens = 4096, temperature = 0 }) {
  const modelCandidates = [...new Set([openAIModel, ...openAIFallbackModels])];
  let lastError = "";
  const modelErrors = [];

  for (const modelCandidate of modelCandidates) {
    const userContent = [{ type: "input_text", text: String(userPrompt || "") }];
    images.forEach((img, index) => {
      const mimeType = img?.mimeType || "image/png";
      const base64 = String(img?.base64 || "").trim();
      if (!base64) return;
      userContent.push({ type: "input_text", text: `Imagen ${index + 1}: ${img?.label || "captura"}` });
      userContent.push({ type: "input_image", image_url: `data:${mimeType};base64,${base64}` });
    });

    const payloadBody = {
      model: modelCandidate,
      temperature,
      max_output_tokens: maxTokens,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: String(systemPrompt || "") }]
        },
        {
          role: "user",
          content: userContent
        }
      ]
    };

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(payloadBody)
      });
    } catch (networkError) {
      const code = networkError?.cause?.code || networkError?.code || "NETWORK_ERROR";
      const message = networkError?.cause?.message || networkError?.message || "Sin detalle de red";
      throw new Error(`No se pudo conectar con OpenAI (${code}): ${message}`);
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch (_e) {
      payload = {};
    }

    if (response.ok) {
      const text = extractOpenAIText(payload);
      if (!text) throw new Error("OpenAI no devolvió texto utilizable");
      return text;
    }

    const errorText = payload?.error?.message || payload?.error?.type || "Error OpenAI API";
    lastError = errorText;
    modelErrors.push(`${modelCandidate}: ${errorText}`);
    const maybeModelError =
      /model/i.test(errorText) ||
      payload?.error?.code === "model_not_found" ||
      payload?.error?.type === "invalid_request_error";
    if (!maybeModelError) {
      throw new Error(errorText);
    }
  }

  const joined = modelErrors.length ? ` | Intentos: ${modelErrors.join(" || ")}` : "";
  throw new Error((lastError || "No se pudo usar ninguno de los modelos OpenAI configurados") + joined);
}

app.post(
  "/api/auditar",
  upload.fields([
    { name: "happyFox", maxCount: 1 },
    { name: "plataforma", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const iaProvider = normalizarProveedorIA(req.body?.iaProvider || "claude");
      if (iaProvider === "openai") {
        if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "tu_openai_api_key_aqui") {
          return res.status(500).json({
            ok: false,
            error: "OPENAI_API_KEY no es valida o no esta configurada en .env"
          });
        }
      } else if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "tu_claude_api_key_aqui") {
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

      let parsed;
      const completionText =
        iaProvider === "openai"
          ? await callOpenAIWithFallback({
              systemPrompt:
                "Eres auditor de pauta digital para una central de medios. Compara pedido vs configuración real sin inventar. Debes escribir hallazgos claros para equipo operativo y responder solo JSON.",
              userPrompt: promptText,
              images: [
                {
                  label: "Solicitud en Happy Fox",
                  mimeType: happyFoxFile.mimetype,
                  base64: happyFoxFile.buffer.toString("base64")
                },
                {
                  label: "Configuración en plataforma",
                  mimeType: plataformaFile.mimetype,
                  base64: plataformaFile.buffer.toString("base64")
                }
              ]
            })
          : await callAnthropicWithFallback({
              systemPrompt:
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
            });
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

      parsed = normalizarResultadoAuditoria(parsed);
      parsed.iaProvider = etiquetaProveedorIA(iaProvider);

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

app.post("/api/chat-auditoria", async (req, res) => {
  try {
    const iaProvider = normalizarProveedorIA(req.body?.iaProvider || "claude");
    if (iaProvider === "openai") {
      if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "tu_openai_api_key_aqui") {
        return res.status(500).json({
          ok: false,
          error: "OPENAI_API_KEY no es valida o no esta configurada en .env"
        });
      }
    } else if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === "tu_claude_api_key_aqui") {
      return res.status(500).json({
        ok: false,
        error: "ANTHROPIC_API_KEY no es valida o no esta configurada en .env"
      });
    }

    const mensaje = String(req.body?.mensaje || "").trim();
    if (!mensaje) {
      return res.status(400).json({
        ok: false,
        error: "Debes enviar un mensaje para chatear con el auditor"
      });
    }

    const plataformaNombre = String(req.body?.plataformaNombre || "No especificada").trim();
    const resultadoActualRaw = req.body?.resultadoActual || {};
    const rawCampos = Array.isArray(resultadoActualRaw?.campos) ? resultadoActualRaw.campos : [];
    if (!rawCampos.length) {
      return res.status(400).json({
        ok: false,
        error: "No se recibió un resultado base válido para reevaluar"
      });
    }
    const resultadoBase = normalizarResultadoAuditoria(resultadoActualRaw);

    const chatHistorial = Array.isArray(req.body?.chatHistorial)
      ? req.body.chatHistorial
          .slice(-10)
          .map((item) => ({
            role: item?.role === "assistant" ? "assistant" : "user",
            text: String(item?.text || "").slice(0, 800)
          }))
          .filter((item) => item.text.trim().length > 0)
      : [];

    const historialTexto = chatHistorial.length
      ? chatHistorial.map((item) => `${item.role === "assistant" ? "Auditor" : "Usuario"}: ${item.text}`).join("\n")
      : "Sin historial previo";

    const promptChat = `Plataforma seleccionada: ${plataformaNombre}
Resultado actual de auditoría (JSON):
${JSON.stringify(resultadoBase, null, 2)}

Historial de chat:
${historialTexto}

Nueva instrucción del usuario:
${mensaje}

Tarea:
- Responde con lenguaje claro para planners y traffickers.
- Si corresponde, corrige/reevalúa el resultado actual en base al mensaje del usuario y el resultado existente.
- No inventes datos no visibles.
- Si Happy Fox y plataforma están ambos no visibles para un campo, ese estado debe ser "no_visible".
- Mantén EXACTAMENTE los 8 campos obligatorios: segmentación, inversión/presupuesto, fechas, objetivo de campaña, audiencias, geografía, ubicaciones, creatividad/formato.
- Devuelve SOLO JSON válido, sin markdown.

Formato de salida obligatorio:
{
  "respuesta": string,
  "resultadoActualizado": {
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
  }
}`;

    const completionText =
      iaProvider === "openai"
        ? await callOpenAIWithFallback({
            systemPrompt:
              "Eres auditor senior de pauta digital. Respondes en español claro y siempre devuelves JSON válido cuando se solicita.",
            userPrompt: promptChat,
            maxTokens: 3072,
            temperature: 0
          })
        : await callAnthropicWithFallback({
            systemPrompt:
              "Eres auditor senior de pauta digital. Respondes en español claro y siempre devuelves JSON válido cuando se solicita.",
            maxTokens: 3072,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: promptChat }]
              }
            ]
          });

    let parsedChat;
    try {
      parsedChat = parseJsonFromModelOutput(completionText);
    } catch (_e) {
      parsedChat = {
        respuesta: completionText || "No pude interpretar la solicitud.",
        resultadoActualizado: resultadoBase
      };
    }

    const respuesta =
      typeof parsedChat?.respuesta === "string" && parsedChat.respuesta.trim()
        ? parsedChat.respuesta.trim()
        : "Reevalué el resultado según tu mensaje.";

    const resultadoActualizado = normalizarResultadoAuditoria(
      parsedChat?.resultadoActualizado || parsedChat?.resultado || resultadoBase,
      resultadoBase
    );
    resultadoActualizado.iaProvider = etiquetaProveedorIA(iaProvider);

    return res.json({
      ok: true,
      respuesta,
      iaProvider: etiquetaProveedorIA(iaProvider),
      resultadoActualizado
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Error al chatear con IA",
      detalle: error?.message || "Error desconocido"
    });
  }
});

app.listen(port, () => {
  console.log(`Servidor activo en http://localhost:${port}`);
  console.log(`Modelo Anthropic activo: ${anthropicModel}`);
});
