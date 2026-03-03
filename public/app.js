const form = document.getElementById("auditForm");
const resultado = document.getElementById("resultado");
const historial = document.getElementById("historial");
const auditButton = document.getElementById("auditButton");
const veredictoBox = document.getElementById("veredictoBox");
const exportPdfBtn = document.getElementById("exportPdfBtn");

const happyFoxInput = document.getElementById("happyFox");
const plataformaInput = document.getElementById("plataforma");
const happyFoxName = document.getElementById("happyFoxName");
const plataformaName = document.getElementById("plataformaName");
const plataformaSelect = document.getElementById("plataformaNombre");
const iaProviderSelect = document.getElementById("iaProvider");
const platformLogo = document.getElementById("platformLogo");
const chatPanel = document.getElementById("chatAuditoria");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatSendButton = document.getElementById("chatSendButton");

const HISTORY_KEY = "qa_auditoria_historial_v1";
let ultimoResultadoParaPdf = null;
let ultimoResultadoChat = null;
let ultimoAdjuntoPdf = {
  happyFox: null,
  plataforma: null
};
let chatTurns = [];

const PLATFORM_LOGOS = {
  TikTok: "/tiktok-logo.svg",
  Meta: "/meta-logo.svg",
  Google: "/google-logo.svg"
};

const DEFAULT_API_BASE_URL = "https://qa-auditor-app.onrender.com";
const configuredApiBase = String(window.QA_API_BASE_URL || "").trim();
const API_BASE_URL =
  configuredApiBase && !configuredApiBase.includes("TU_BACKEND_RENDER")
    ? configuredApiBase
    : DEFAULT_API_BASE_URL;
const AUDIT_API_URL = `${API_BASE_URL.replace(/\/$/, "")}/api/auditar`;
const CHAT_API_URL = `${API_BASE_URL.replace(/\/$/, "")}/api/chat-auditoria`;

async function parseApiJson(response, targetUrl = AUDIT_API_URL) {
  const contentType = response.headers.get("content-type") || "sin content-type";
  const statusInfo = `${response.status} ${response.statusText}`.trim();
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const preview = raw.trim().slice(0, 120).replace(/\s+/g, " ");
    throw new Error(
      `La API no devolvió JSON (${statusInfo}, ${contentType}). URL: ${targetUrl}. Respuesta: ${preview || "vacía"}`
    );
  }
}

async function imageUrlToDataUrl(url) {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const w = Math.max(64, img.naturalWidth || 64);
          const h = Math.max(64, img.naturalHeight || 64);
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            URL.revokeObjectURL(blobUrl);
            resolve("");
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const pngDataUrl = canvas.toDataURL("image/png");
          URL.revokeObjectURL(blobUrl);
          resolve(pngDataUrl);
        } catch (_e) {
          URL.revokeObjectURL(blobUrl);
          resolve("");
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        resolve("");
      };
      img.src = blobUrl;
    });
  } catch (_e) {
    return "";
  }
}

happyFoxInput.addEventListener("change", () => {
  happyFoxName.textContent = happyFoxInput.files?.[0]?.name || "Ningún archivo seleccionado";
});

plataformaInput.addEventListener("change", () => {
  plataformaName.textContent = plataformaInput.files?.[0]?.name || "Ningún archivo seleccionado";
});

function actualizarLogoPlataforma() {
  const plataforma = plataformaSelect.value;
  const logoUrl = PLATFORM_LOGOS[plataforma] || PLATFORM_LOGOS.Meta;
  platformLogo.src = logoUrl;
  platformLogo.alt = `Logo de ${plataforma}`;
}

function etiquetaProveedorIA(value = "") {
  return String(value || "").toLowerCase().includes("openai") ? "OpenAI" : "Claude";
}

function appendChatMessage(role, text) {
  if (!chatMessages) return null;
  const card = document.createElement("article");
  card.className = `chat-message chat-${role}`;

  const roleLabel = document.createElement("strong");
  roleLabel.className = "chat-role";
  roleLabel.textContent = role === "user" ? "Tú" : role === "system" ? "Sistema" : "Auditor IA";

  const body = document.createElement("p");
  body.className = "chat-text";
  body.textContent = String(text || "");

  card.appendChild(roleLabel);
  card.appendChild(body);
  chatMessages.appendChild(card);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return card;
}

function limpiarChatUI() {
  chatTurns = [];
  if (chatMessages) chatMessages.innerHTML = "";
  if (chatInput) chatInput.value = "";
  if (chatPanel) chatPanel.classList.add("oculto");
}

function iniciarChatUI() {
  if (!chatPanel || !chatMessages) return;
  chatTurns = [];
  chatMessages.innerHTML = "";
  const providerLabel = ultimoResultadoChat?.iaProvider || etiquetaProveedorIA(iaProviderSelect?.value);
  appendChatMessage("assistant", `Resultado listo con ${providerLabel}. Puedes pedirme reevaluar o corregir campos específicos.`);
  chatPanel.classList.remove("oculto");
}

function acotarChatHistorial(turns = []) {
  return turns
    .slice(-10)
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : "user",
      text: String(item?.text || "").slice(0, 800)
    }))
    .filter((item) => item.text.trim().length > 0);
}

function guardarEnHistorial(item) {
  const historialActual = obtenerHistorial();
  historialActual.unshift(item);
  const limitado = historialActual.slice(0, 10);
  guardarHistorial(limitado);
}

function obtenerHistorial() {
  return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
}

function guardarHistorial(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
}

function borrarItemHistorial(index) {
  const historialActual = obtenerHistorial();
  historialActual.splice(index, 1);
  guardarHistorial(historialActual);
  renderHistorial();
}

function borrarTodoHistorial() {
  guardarHistorial([]);
  renderHistorial();
}

function renderHistorial() {
  const historialActual = obtenerHistorial();
  if (!historialActual.length) {
    historial.innerHTML = `
      <h2>Campos archivados (historial)</h2>
      <p class="muted">Todavía no hay auditorías archivadas.</p>
    `;
    return;
  }

  const items = historialActual
    .map((item, index) => {
      const estado = item.aprobado ? "Aprobado" : "Con diferencias";
      const clase = item.aprobado ? "estado-ok" : "estado-warn";
      const campos = (item.campos || [])
        .map(
          (campo) =>
            `<li><strong>${formatoCampo(campo.campo)}</strong>: ${campo.estado} - ${campo.diferencia || "Sin diferencia reportada"}</li>`
        )
        .join("");
      return `
        <article class="historial-item">
          <div class="historial-head">
            <p><strong>${item.fecha}</strong> | ${item.plataforma} | IA: ${item.iaProvider || "Claude"} | <span class="${clase}">${estado}</span></p>
            <button class="history-btn danger" data-history-delete="${index}" type="button">Borrar</button>
          </div>
          <ul>${campos || "<li>Sin campos detectados</li>"}</ul>
        </article>
      `;
    })
    .join("");

  historial.innerHTML = `
    <div class="historial-toolbar">
      <h2>Campos archivados (historial)</h2>
      <button class="history-btn danger" data-history-clear="true" type="button">Borrar todo</button>
    </div>
    ${items}
  `;
}

function normalizarCampoUI(item = {}) {
  let estado = item.estado || "no_visible";
  const campo = item.campo || "campo_sin_nombre";
  const detalle = item.detalle || "";
  const happyfoxDerivado =
    typeof detalle === "string" && /happy fox/i.test(detalle)
      ? (detalle.match(/en happy fox([^.,;]*)/i)?.[0] || "").trim()
      : "";
  const plataformaDerivada =
    typeof detalle === "string" && /plataforma/i.test(detalle)
      ? (detalle.match(/en la plataforma([^.,;]*)/i)?.[0] || "").trim()
      : "";
  const happyfox = item.happyfox || item.happyFox || happyfoxDerivado || "No visible en captura de Happy Fox.";
  const plataforma = item.plataforma || plataformaDerivada || "No visible en captura de plataforma.";

  // Regla de consistencia: si ambas fuentes están no visibles, no puede quedar "correcto".
  if (estado === "correcto" && esNoVisibleTexto(happyfox) && esNoVisibleTexto(plataforma)) {
    estado = "no_visible";
  }

  return {
    campo,
    estado,
    happyfox,
    plataforma,
    diferencia: item.diferencia || detalle || "Sin diferencia reportada.",
    accion:
      item.accion ||
      (estado === "correcto"
        ? `Sin cambios en ${campo}.`
        : estado === "no_visible"
          ? `Validar y documentar ${campo} en ambas capturas para auditoría.`
          : `Ajustar ${campo} en plataforma para que coincida con Happy Fox.`)
  };
}

function formatoCampo(campo = "") {
  if (!campo) return "Campo";
  return campo.charAt(0).toUpperCase() + campo.slice(1);
}

function esNoVisibleTexto(texto = "") {
  return typeof texto === "string" && texto.toLowerCase().includes("no visible");
}

function recuperarResultadoDesdeAlertas(data) {
  const resumen = (data?.resumen || "").toLowerCase();
  if (!resumen.includes("no se pudo parsear")) return data;
  const alerta = (data?.alertas || []).find((a) => typeof a === "string" && a.includes("{") && a.includes("}"));
  if (!alerta) return data;

  const cleaned = alerta.replace(/```json/gi, "```").replace(/```/g, "").trim();
  const body = cleaned.match(/\{[\s\S]*\}/)?.[0];
  if (!body) return data;

  try {
    const parseLoose = (text) => {
      try {
        return JSON.parse(text);
      } catch (_e) {
        return JSON.parse(text.replace(/,\s*([}\]])/g, "$1").replace(/[\r\n\t]/g, " ").trim());
      }
    };
    const parsed = parseLoose(body);
    return {
      resumen: parsed?.resumen || data.resumen,
      aprobado: Boolean(parsed?.aprobado),
      campos: Array.isArray(parsed?.campos) ? parsed.campos.map(normalizarCampoUI) : [],
      alertas: Array.isArray(parsed?.alertas) ? parsed.alertas : [],
      plataformaNombre: data?.plataformaNombre || "No especificada"
    };
  } catch (_e) {
    const parseLooseObject = (text) => {
      try {
        return JSON.parse(text);
      } catch (_err) {
        return JSON.parse(text.replace(/,\s*([}\]])/g, "$1").replace(/[\r\n\t]/g, " ").trim());
      }
    };

    const resumenMatch = body.match(/"resumen"\s*:\s*"([\s\S]*?)"\s*,\s*"aprobado"/i);
    const aprobadoMatch = body.match(/"aprobado"\s*:\s*(true|false)/i);
    const camposSectionMatch = body.match(/"campos"\s*:\s*\[([\s\S]*)/i);
    const camposRawSection = camposSectionMatch?.[1] || "";
    const objectMatches = camposRawSection.match(/\{[\s\S]*?\}(?=\s*,|\s*\])/g) || [];

    const camposRecuperados = objectMatches
      .map((chunk) => {
        try {
          return parseLooseObject(chunk);
        } catch (_err) {
          return null;
        }
      })
      .filter(Boolean)
      .map(normalizarCampoUI);

    if (!camposRecuperados.length) return data;

    return {
      resumen: (resumenMatch?.[1] || "Resultado recuperado parcialmente por truncamiento de respuesta.").replace(/\\"/g, '"'),
      aprobado: aprobadoMatch?.[1] === "true",
      campos: camposRecuperados,
      alertas: ["Respuesta de IA truncada. Se muestran los campos recuperados parcialmente."],
      plataformaNombre: data?.plataformaNombre || "No especificada"
    };
  }
}

function renderResultado(data, options = {}) {
  const { resetChat = false, saveHistory = true } = options;
  const safeData = recuperarResultadoDesdeAlertas(data);
  const iaProviderLabel = safeData.iaProvider || etiquetaProveedorIA(iaProviderSelect?.value);
  const aprobadoClass = safeData.aprobado ? "estado-ok" : "estado-warn";
  const aprobadoText = safeData.aprobado ? "Aprobado" : "Requiere correcciones";
  const campos = (safeData.campos || []).map(normalizarCampoUI);
  const faltantes = campos.filter((item) => item.estado === "diferencia");
  const noVisibles = campos.filter((item) => item.estado === "no_visible");
  const correctos = campos.filter((item) => item.estado === "correcto");

  const camposHtml = campos
    .map((item) => {
      const noVisibleEnAmbas =
        item.estado === "no_visible" && esNoVisibleTexto(item.happyfox) && esNoVisibleTexto(item.plataforma);
      const badgeClass =
        item.estado === "correcto"
          ? "badge-ok"
          : item.estado === "diferencia"
            ? "badge-diff"
            : noVisibleEnAmbas
              ? "badge-novis-ambas"
              : "badge-novis";
      const badgeText =
        item.estado === "correcto" ? "Correcto" : item.estado === "diferencia" ? "Diferencia" : "No visible";
      const cardClass =
        item.estado === "no_visible" && noVisibleEnAmbas
          ? "campo-item campo-no_visible campo-no_visible-ambas"
          : `campo-item campo-${item.estado}`;
      return `
        <article class="${cardClass}">
          <div class="campo-head">
            <strong>${formatoCampo(item.campo)}</strong>
            <span class="${badgeClass}">${badgeText}</span>
          </div>
          <p><strong>Happy Fox:</strong> ${item.happyfox || "Sin evidencia visible"}</p>
          <p><strong>Plataforma:</strong> ${item.plataforma || "Sin evidencia visible"}</p>
          <p><strong>Diferencia:</strong> ${item.diferencia || "Sin diferencias reportadas"}</p>
          <p><strong>Acción sugerida:</strong> ${item.accion || "Sin acción sugerida"}</p>
        </article>
      `;
    })
    .join("");

  const alertasHtml = (safeData.alertas || []).length
    ? `<h3>Alertas</h3><ul>${safeData.alertas.map((a) => `<li>${a}</li>`).join("")}</ul>`
    : "";

  resultado.innerHTML = `
    <h2>Resultado de auditoría</h2>
    <p><strong>Plataforma:</strong> ${safeData.plataformaNombre || "No especificada"}</p>
    <p><strong>Motor IA:</strong> ${iaProviderLabel}</p>
    <p><strong>Resumen:</strong> ${safeData.resumen || "Sin resumen"}</p>
    <p class="${aprobadoClass}">Estado general: ${aprobadoText}</p>
    <p><strong>Campos correctos:</strong> ${correctos.length}</p>
    <p><strong>Campos con diferencia:</strong> ${faltantes.length}</p>
    <p><strong>Campos no visibles:</strong> ${noVisibles.length}</p>
    <h3>Detalle por campos</h3>
    <div class="campos-grid">${camposHtml || "<p>No se detectaron campos visibles</p>"}</div>
    ${alertasHtml}
  `;

  if (campos.length === 0 && !safeData.aprobado) {
    veredictoBox.innerHTML =
      '<span class="estado-warn">Veredicto: la IA no pudo validar campos suficientes, revisa el detalle.</span>';
  } else if (safeData.aprobado && faltantes.length === 0) {
    veredictoBox.innerHTML = '<span class="estado-ok">Veredicto: todo está perfecto.</span>';
  } else {
    veredictoBox.innerHTML = `<span class="estado-warn">Veredicto: hay ${faltantes.length} campo(s) con diferencia y ${noVisibles.length} no visible(s).</span>`;
  }

  if (saveHistory) {
    guardarEnHistorial({
      fecha: new Date().toLocaleString("es-EC"),
      plataforma: safeData.plataformaNombre || "No especificada",
      iaProvider: iaProviderLabel,
      aprobado: safeData.aprobado,
      campos
    });
  }

  ultimoResultadoChat = {
    plataformaNombre: safeData.plataformaNombre || "No especificada",
    iaProvider: iaProviderLabel,
    resumen: safeData.resumen || "Sin resumen",
    aprobado: Boolean(safeData.aprobado),
    campos,
    alertas: Array.isArray(safeData.alertas) ? safeData.alertas : []
  };

  ultimoResultadoParaPdf = {
    plataformaNombre: safeData.plataformaNombre || "No especificada",
    iaProvider: iaProviderLabel,
    resumen: safeData.resumen || "Sin resumen",
    estadoGeneral: aprobadoText,
    correctos: correctos.length,
    diferencia: faltantes.length,
    noVisibles: noVisibles.length,
    campos,
    alertas: safeData.alertas || []
  };
  exportPdfBtn.disabled = false;

  if (resetChat) {
    iniciarChatUI();
  } else if (chatPanel) {
    chatPanel.classList.remove("oculto");
  }

  renderHistorial();
  resultado.classList.remove("oculto");
}

function limpiarNombreArchivo(texto) {
  return String(texto || "plataforma")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function exportarResultadoPDF() {
  if (!ultimoResultadoParaPdf) return;
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("No se pudo cargar la librería PDF. Recarga la página e intenta otra vez.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const marginX = 40;
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = doc.internal.pageSize.getWidth() - marginX * 2;
  let y = 48;
  const estadoColor = (estado) => {
    if (estado === "correcto") return { text: [26, 132, 77], fill: [212, 245, 224] };
    if (estado === "diferencia") return { text: [183, 38, 52], fill: [252, 224, 228] };
    return { text: [168, 118, 0], fill: [255, 241, 196] };
  };

  const ensureSpace = (needed = 22) => {
    if (y + needed > pageHeight - 42) {
      doc.addPage();
      y = 48;
    }
  };

  const addWrapped = (text, size = 11, gap = 16) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(20, 20, 30);
    const lines = doc.splitTextToSize(String(text), usableWidth);
    lines.forEach((line) => {
      ensureSpace(gap);
      doc.text(line, marginX, y);
      y += gap;
    });
  };

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 30);
  doc.text("Resultado de auditoría", marginX, y);

  const logoDataUrl = await imageUrlToDataUrl(platformLogo.src || "");
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, "PNG", doc.internal.pageSize.getWidth() - 82, 30, 36, 36);
    } catch (_e) {
      // Si falla el logo, el resto del PDF se genera igual.
    }
  } else {
    doc.setDrawColor(140, 120, 220);
    doc.setFillColor(26, 18, 52);
    doc.roundedRect(doc.internal.pageSize.getWidth() - 116, 28, 76, 24, 6, 6, "FD");
    doc.setTextColor(230, 220, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(String(ultimoResultadoParaPdf.plataformaNombre || "Plataforma"), doc.internal.pageSize.getWidth() - 108, 44);
    doc.setTextColor(20, 20, 30);
  }

  y += 24;

  addWrapped(`Plataforma: ${ultimoResultadoParaPdf.plataformaNombre}`);
  addWrapped(`Motor IA: ${ultimoResultadoParaPdf.iaProvider || "Claude"}`);
  addWrapped(`Resumen: ${ultimoResultadoParaPdf.resumen}`);
  addWrapped(`Estado general: ${ultimoResultadoParaPdf.estadoGeneral}`);
  addWrapped(`Campos correctos: ${ultimoResultadoParaPdf.correctos}`);
  addWrapped(`Campos con diferencia: ${ultimoResultadoParaPdf.diferencia}`);
  addWrapped(`Campos no visibles: ${ultimoResultadoParaPdf.noVisibles}`);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(20, 20, 30);
  ensureSpace(22);
  doc.text("Detalle por campos", marginX, y);
  y += 20;

  ultimoResultadoParaPdf.campos.forEach((campo) => {
    ensureSpace(26);
    const color = estadoColor(campo.estado);
    doc.setFillColor(...color.fill);
    doc.roundedRect(marginX, y - 12, 10, 10, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...color.text);
    doc.text(`${formatoCampo(campo.campo)} (${campo.estado})`, marginX + 16, y - 2);
    y += 16;
    addWrapped(`Happy Fox: ${campo.happyfox}`, 11, 14);
    addWrapped(`Plataforma: ${campo.plataforma}`, 11, 14);
    addWrapped(`Diferencia: ${campo.diferencia}`, 11, 14);
    addWrapped(`Acción sugerida: ${campo.accion}`, 11, 14);
    y += 6;
  });

  if (ultimoResultadoParaPdf.alertas.length) {
    ensureSpace(22);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(20, 20, 30);
    doc.text("Alertas", marginX, y);
    y += 18;
    ultimoResultadoParaPdf.alertas.forEach((alerta) => addWrapped(`- ${alerta}`, 11, 14));
  }

  const drawImageBlock = (title, imageObj) => {
    if (!imageObj?.dataUrl) return;
    doc.addPage();
    y = 48;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(title, marginX, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.text(`Archivo: ${imageObj.fileName || "sin_nombre"}`, marginX, y);
    y += 16;

    const maxW = usableWidth;
    const maxH = pageHeight - y - 42;
    let drawW = imageObj.width || maxW;
    let drawH = imageObj.height || maxH;
    const ratio = Math.min(maxW / drawW, maxH / drawH, 1);
    drawW *= ratio;
    drawH *= ratio;

    const x = marginX + (maxW - drawW) / 2;
    doc.addImage(imageObj.dataUrl, imageObj.format || "JPEG", x, y, drawW, drawH);
  };

  drawImageBlock("Captura de Happy Fox", ultimoAdjuntoPdf.happyFox);
  drawImageBlock("Captura de plataforma", ultimoAdjuntoPdf.plataforma);

  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const platformSafe = limpiarNombreArchivo(ultimoResultadoParaPdf.plataformaNombre);
  doc.save(`resultado_auditoria_${platformSafe}_${dateStr}.pdf`);
}

function fileToImageMeta(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const img = new Image();
      img.onload = () => {
        const mime = file.type || "";
        const format = mime.includes("png") ? "PNG" : "JPEG";
        resolve({
          fileName: file.name,
          dataUrl,
          width: img.width,
          height: img.height,
          format
        });
      };
      img.onerror = () => {
        resolve({
          fileName: file.name,
          dataUrl,
          width: 1200,
          height: 800,
          format: "JPEG"
        });
      };
      img.src = dataUrl;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  limpiarChatUI();
  const formData = new FormData(form);
  const happyFoxFile = happyFoxInput.files?.[0] || null;
  const plataformaFile = plataformaInput.files?.[0] || null;
  auditButton.disabled = true;
  auditButton.textContent = "Auditando...";
  veredictoBox.textContent = "Veredicto: analizando imágenes...";
  resultado.classList.remove("oculto");
  resultado.innerHTML = "<p>Procesando imágenes con IA...</p>";

  try {
    const [happyFoxMeta, plataformaMeta] = await Promise.all([
      fileToImageMeta(happyFoxFile),
      fileToImageMeta(plataformaFile)
    ]);
    ultimoAdjuntoPdf = {
      happyFox: happyFoxMeta,
      plataforma: plataformaMeta
    };

    const response = await fetch(AUDIT_API_URL, {
      method: "POST",
      body: formData
    });

    const payload = await parseApiJson(response, AUDIT_API_URL);

    if (!response.ok || !payload.ok) {
      throw new Error(
        `${payload.error || "No se pudo completar la auditoría"}${
          payload.detalle ? `: ${payload.detalle}` : ""
        }`
      );
    }

    renderResultado(
      {
        ...payload.resultado,
        plataformaNombre: plataformaSelect.value,
        iaProvider: payload.resultado?.iaProvider || etiquetaProveedorIA(iaProviderSelect?.value)
      },
      { resetChat: true, saveHistory: true }
    );
  } catch (error) {
    resultado.innerHTML = `<p class="estado-warn">Error: ${error.message}</p>`;
    veredictoBox.innerHTML = `<span class="estado-warn">Veredicto: no se pudo analizar. ${error.message}</span>`;
  } finally {
    auditButton.disabled = false;
    auditButton.textContent = "Auditar";
  }
});

renderHistorial();

historial.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const deleteIndex = target.getAttribute("data-history-delete");
  if (deleteIndex !== null) {
    borrarItemHistorial(Number(deleteIndex));
    return;
  }

  if (target.getAttribute("data-history-clear") === "true") {
    borrarTodoHistorial();
  }
});

if (chatForm) {
  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const mensaje = String(chatInput?.value || "").trim();
    if (!mensaje) return;

    if (!ultimoResultadoChat || !Array.isArray(ultimoResultadoChat.campos) || !ultimoResultadoChat.campos.length) {
      appendChatMessage("system", "Primero ejecuta una auditoría para habilitar el chat.");
      return;
    }

    appendChatMessage("user", mensaje);
    chatTurns.push({ role: "user", text: mensaje });
    if (chatInput) chatInput.value = "";

    if (chatSendButton) {
      chatSendButton.disabled = true;
      chatSendButton.textContent = "Consultando...";
    }

    const pending = appendChatMessage("assistant", "Estoy reevaluando el resultado...");

    try {
      const response = await fetch(CHAT_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          mensaje,
          iaProvider: iaProviderSelect?.value || "claude",
          plataformaNombre: ultimoResultadoChat.plataformaNombre || plataformaSelect.value || "No especificada",
          resultadoActual: ultimoResultadoChat,
          chatHistorial: acotarChatHistorial(chatTurns)
        })
      });

      const payload = await parseApiJson(response, CHAT_API_URL);
      if (!response.ok || !payload.ok) {
        throw new Error(
          `${payload.error || "No se pudo procesar el chat"}${
            payload.detalle ? `: ${payload.detalle}` : ""
          }`
        );
      }

      if (pending) pending.remove();

      const respuesta = String(payload.respuesta || "Resultado actualizado con base en tu solicitud.").trim();
      appendChatMessage("assistant", respuesta);
      chatTurns.push({ role: "assistant", text: respuesta });

      if (payload.resultadoActualizado) {
        renderResultado(
          {
            ...payload.resultadoActualizado,
            iaProvider:
              payload.resultadoActualizado?.iaProvider ||
              payload.iaProvider ||
              ultimoResultadoChat.iaProvider ||
              etiquetaProveedorIA(iaProviderSelect?.value),
            plataformaNombre:
              payload.resultadoActualizado?.plataformaNombre ||
              ultimoResultadoChat.plataformaNombre ||
              plataformaSelect.value
          },
          { resetChat: false, saveHistory: false }
        );
      }
    } catch (error) {
      if (pending) pending.remove();
      appendChatMessage("system", `No pude procesar la solicitud: ${error.message}`);
    } finally {
      if (chatSendButton) {
        chatSendButton.disabled = false;
        chatSendButton.textContent = "Enviar al auditor";
      }
    }
  });
}

exportPdfBtn.addEventListener("click", exportarResultadoPDF);
plataformaSelect.addEventListener("change", actualizarLogoPlataforma);
actualizarLogoPlataforma();
