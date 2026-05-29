// Frigate UI — vanilla JS. Talks to /api/* (proxied to Frigate).
"use strict";

const API = "/api";
const FFMPEG_ROLES = ["detect", "record", "audio"];
const TRACKED_OBJECTS = ["person","car","truck","motorcycle","bicycle","bus","dog","cat","bird","package"];

let configDoc = null;   // parsed JS object
let rawYaml = "";       // raw YAML string
let had = {};           // which root sections existed at load time

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "onclick") n.onclick = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    n.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return n;
};
const setStatus = (msg, cls = "") => {
  const s = $("#status");
  s.textContent = msg;
  s.className = "status " + cls;
};
const toast = (msg, cls = "ok") => {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + cls;
  t.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = "none"), 3500);
};
const get = (obj, path, dflt) => {
  if (!obj) return dflt;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return dflt;
    cur = cur[p];
  }
  return cur === undefined ? dflt : cur;
};
const setPath = (obj, path, value) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts.at(-1)] = value;
};
const pruneEmpty = (obj) => {
  if (Array.isArray(obj)) {
    return obj.map(pruneEmpty).filter(v => v !== undefined);
  }
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const p = pruneEmpty(v);
      if (p === undefined || p === "" || p === null) continue;
      if (typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return out;
  }
  return obj;
};

// ---------- tabs ----------
$$("#tabs button").forEach(btn => {
  btn.onclick = () => {
    $$("#tabs button").forEach(b => b.classList.toggle("active", b === btn));
    const tab = btn.dataset.tab;
    $$(".tab").forEach(s => s.classList.toggle("active", s.dataset.tab === tab));
    if (tab === "raw") $("#rawEditor").value = jsyaml.dump(configDoc, { lineWidth: 120, noRefs: true });
  };
});

// ---------- load / save ----------
async function loadConfig() {
  setStatus("carregando...");
  try {
    // Frigate serves the raw config.yml at /api/config/raw (text/plain)
    const res = await fetch(`${API}/config/raw`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let text = await res.text();
    // Frigate may return the YAML as a JSON-encoded string — detect and unwrap.
    const t = text.trim();
    if (t.startsWith('"') && t.endsWith('"')) {
      try { text = JSON.parse(t); } catch {}
    }
    rawYaml = text;
    configDoc = jsyaml.load(rawYaml) || {};
    had = {
      mqtt: "mqtt" in configDoc,
      detectors: "detectors" in configDoc,
      record: "record" in configDoc,
      snapshots: "snapshots" in configDoc,
      objects: "objects" in configDoc,
      go2rtc: "go2rtc" in configDoc,
    };
    renderAll();
    setStatus("conectado", "ok");
  } catch (e) {
    setStatus("erro: " + e.message, "err");
    toast("Falha ao carregar: " + e.message, "err");
  }
}

async function saveConfig(restart = false) {
  collectAll();
  const yaml = jsyaml.dump(configDoc, { lineWidth: 120, noRefs: true });
  const save_option = restart ? "restart" : "saveonly";
  setStatus("salvando...");
  try {
    const res = await fetch(`${API}/config/save?save_option=${save_option}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    rawYaml = yaml;
    if (restart) {
      // O save_option=restart reinicia só o serviço frigate — o go2rtc NÃO
      // recarrega os streams sem reiniciar a unidade dele. Sem isto, mudanças
      // em go2rtc/streams ficam salvas mas não entram no ar.
      setStatus("salvo — reiniciando Frigate + go2rtc");
      let g2 = true;
      try {
        const r2 = await fetch("/restart-go2rtc", { method: "POST" });
        g2 = r2.ok;
      } catch { g2 = false; }
      setStatus(g2 ? "salvo — reiniciando" : "salvo (go2rtc não reiniciou)", g2 ? "ok" : "err");
      toast(g2 ? "Salvo. Reiniciando Frigate e go2rtc..." : "Salvo, mas falha ao reiniciar go2rtc", g2 ? "ok" : "err");
    } else {
      setStatus("salvo", "ok");
      toast("Config salva ✓", "ok");
    }
  } catch (e) {
    setStatus("erro ao salvar", "err");
    toast("Falha: " + e.message, "err");
  }
}

// ---------- render / collect ----------
function renderAll() {
  renderMqtt();
  renderDetectors();
  renderRecord();
  renderSnapshots();
  renderObjects();
  renderGo2rtc();
  renderCameras();
}
function collectAll() {
  collectMqtt();
  collectDetectors();
  collectRecord();
  collectSnapshots();
  collectObjects();
  collectGo2rtc();
  collectCameras();
  // if raw tab is active, prefer raw
  if ($(".tab.active").dataset.tab === "raw") {
    try {
      configDoc = jsyaml.load($("#rawEditor").value) || {};
    } catch (e) {
      toast("YAML inválido: " + e.message, "err");
      throw e;
    }
  }
}

// MQTT
function renderMqtt() {
  const m = configDoc.mqtt || {};
  $("#mqtt_enabled").checked = m.enabled !== false;
  $("#mqtt_host").value = m.host || "";
  $("#mqtt_port").value = m.port ?? "";
  $("#mqtt_topic_prefix").value = m.topic_prefix || "";
  $("#mqtt_client_id").value = m.client_id || "";
  $("#mqtt_user").value = m.user || "";
  $("#mqtt_password").value = m.password || "";
  $("#mqtt_stats_interval").value = m.stats_interval ?? "";
}
function collectMqtt() {
  const m = {};
  m.enabled = $("#mqtt_enabled").checked;
  const v = (id) => $(id).value.trim();
  const num = (id) => { const x = $(id).value; return x === "" ? undefined : Number(x); };
  if (v("#mqtt_host")) m.host = v("#mqtt_host");
  const p = num("#mqtt_port"); if (p !== undefined) m.port = p;
  if (v("#mqtt_topic_prefix")) m.topic_prefix = v("#mqtt_topic_prefix");
  if (v("#mqtt_client_id")) m.client_id = v("#mqtt_client_id");
  if (v("#mqtt_user")) m.user = v("#mqtt_user");
  if (v("#mqtt_password")) m.password = v("#mqtt_password");
  const si = num("#mqtt_stats_interval"); if (si !== undefined) m.stats_interval = si;
  const meaningful = Object.keys(m).length > 1 || m.enabled === true;
  if (had.mqtt || meaningful) configDoc.mqtt = m;
  else delete configDoc.mqtt;
}

// Detectors
function renderDetectors() {
  const list = $("#detectorsList");
  list.innerHTML = "";
  const dets = configDoc.detectors || {};
  for (const [name, det] of Object.entries(dets)) {
    list.append(detectorCard(name, det));
  }
}
function detectorCard(name, det) {
  const nameInput = el("input", { type: "text", value: name });
  const typeSelect = el("select",{},
    ...["cpu","edgetpu","openvino","tensorrt","onnx","hailo8l","rknn","rocm","deepstack","nvidia"].map(t =>
      el("option", { value: t, ...(det.type === t ? {selected: ""} : {}) }, t)));
  const device = el("input", { type: "text", value: det.device || "" });
  const model = el("input", { type: "text", value: det.model?.path || "" });
  const numThreads = el("input", { type: "number", value: det.num_threads ?? "" });

  const card = el("div", { class: "list-item open" },
    el("div", { class: "list-item-head" },
      el("span", { class: "caret" }),
      el("span", { class: "name" }, name),
      el("button", {
        class: "btn danger",
        onclick: (e) => { e.stopPropagation(); card.remove(); }
      }, "Remover")
    ),
    el("div", { class: "list-item-body" },
      el("div", { class: "grid" },
        field("Nome", nameInput, null, "Identificador único deste detector. Ex: coral, cpu1."),
        field("Tipo", typeSelect, null, "Backend de inferência. cpu = lento (só teste). edgetpu = Google Coral. openvino = Intel iGPU/CPU. tensorrt = NVIDIA GPU. onnx/rknn/hailo8l = outros aceleradores."),
        field("Device", device, "cpu, usb, pci:0, /dev/apex_0...", "Dispositivo específico. Coral USB: 'usb'. Coral PCI: 'pci'. OpenVINO: 'GPU' ou 'CPU'. TensorRT: '0' (índice da GPU)."),
        field("Threads (CPU)", numThreads, null, "Quantas threads o detector CPU usará. Só relevante para tipo 'cpu'."),
        field("Model path", model, "opcional", "Caminho customizado para o modelo .tflite/.onnx. Deixe vazio para usar o padrão do Frigate."),
      )
    )
  );
  card.querySelector(".list-item-head").onclick = (e) => {
    if (e.target.tagName === "BUTTON") return;
    card.classList.toggle("open");
  };
  card._collect = () => {
    const n = nameInput.value.trim();
    if (!n) return null;
    const out = { type: typeSelect.value };
    if (device.value.trim()) out.device = device.value.trim();
    if (numThreads.value !== "") out.num_threads = Number(numThreads.value);
    if (model.value.trim()) out.model = { path: model.value.trim() };
    return [n, out];
  };
  return card;
}
function collectDetectors() {
  const out = {};
  $$("#detectorsList .list-item").forEach(c => {
    const r = c._collect && c._collect();
    if (r) out[r[0]] = r[1];
  });
  if (Object.keys(out).length) configDoc.detectors = out;
  else delete configDoc.detectors;
}
$("#addDetectorBtn").onclick = () => {
  $("#detectorsList").append(detectorCard(`detector_${Date.now().toString(36)}`, { type: "cpu" }));
};

// Record
function renderRecord() {
  const r = configDoc.record || {};
  $("#record_enabled").checked = r.enabled === true;
  $("#record_retain_days").value = get(r, "retain.days", "");
  $("#record_retain_mode").value = get(r, "retain.mode", "all");
  $("#record_alerts_days").value = get(r, "alerts.retain.days", "");
  $("#record_detections_days").value = get(r, "detections.retain.days", "");
  $("#record_pre_capture").value = get(r, "events.pre_capture", "");
  $("#record_post_capture").value = get(r, "events.post_capture", "");
}
function collectRecord() {
  const r = {};
  r.enabled = $("#record_enabled").checked;
  const nd = (id) => { const x = $(id).value; return x === "" ? undefined : Number(x); };
  const d = nd("#record_retain_days");
  if (d !== undefined) r.retain = { days: d, mode: $("#record_retain_mode").value };
  const ad = nd("#record_alerts_days");
  if (ad !== undefined) r.alerts = { retain: { days: ad, mode: "motion" } };
  const dd = nd("#record_detections_days");
  if (dd !== undefined) r.detections = { retain: { days: dd, mode: "motion" } };
  const pre = nd("#record_pre_capture"), post = nd("#record_post_capture");
  if (pre !== undefined || post !== undefined) {
    r.events = {};
    if (pre !== undefined) r.events.pre_capture = pre;
    if (post !== undefined) r.events.post_capture = post;
  }
  const meaningful = Object.keys(r).length > 1 || r.enabled === true;
  if (had.record || meaningful) configDoc.record = r;
  else delete configDoc.record;
}

// Snapshots
function renderSnapshots() {
  const s = configDoc.snapshots || {};
  $("#snap_enabled").checked = s.enabled === true;
  $("#snap_retain_days").value = get(s, "retain.default", "");
  $("#snap_quality").value = s.quality ?? "";
  $("#snap_clean_copy").checked = s.clean_copy === true;
  $("#snap_timestamp").checked = s.timestamp === true;
  $("#snap_bounding_box").checked = s.bounding_box === true;
  $("#snap_crop").checked = s.crop === true;
}
function collectSnapshots() {
  const s = {};
  s.enabled = $("#snap_enabled").checked;
  const d = $("#snap_retain_days").value;
  if (d !== "") s.retain = { default: Number(d) };
  const q = $("#snap_quality").value;
  if (q !== "") s.quality = Number(q);
  s.clean_copy = $("#snap_clean_copy").checked;
  s.timestamp = $("#snap_timestamp").checked;
  s.bounding_box = $("#snap_bounding_box").checked;
  s.crop = $("#snap_crop").checked;
  const meaningful = s.enabled === true || s.retain !== undefined || s.quality !== undefined
    || s.clean_copy || s.timestamp || s.bounding_box || s.crop;
  if (had.snapshots || meaningful) configDoc.snapshots = s;
  else delete configDoc.snapshots;
}

// Objects
function renderObjects() {
  const list = get(configDoc, "objects.track", []);
  $("#objects_track").value = Array.isArray(list) ? list.join("\n") : "";
}
function collectObjects() {
  const lines = $("#objects_track").value.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length) setPath(configDoc, "objects.track", lines);
  else if (configDoc.objects) delete configDoc.objects.track;
}

// go2rtc
function renderGo2rtc() {
  const streams = get(configDoc, "go2rtc.streams", {});
  const lines = Object.entries(streams).map(([k, v]) => {
    if (Array.isArray(v)) return v.map(u => `${k}: ${u}`).join("\n");
    return `${k}: ${v}`;
  });
  $("#go2rtc_streams").value = lines.join("\n");
}
function collectGo2rtc() {
  const text = $("#go2rtc_streams").value.trim();
  if (!text) {
    if (configDoc.go2rtc) delete configDoc.go2rtc.streams;
    return;
  }
  const streams = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^:#\s][^:]*):\s*(.+?)\s*$/);
    if (!m) continue;
    const [, name, url] = m;
    if (streams[name]) {
      streams[name] = Array.isArray(streams[name]) ? [...streams[name], url] : [streams[name], url];
    } else {
      streams[name] = url;
    }
  }
  setPath(configDoc, "go2rtc.streams", streams);
}

// Cameras
function renderCameras() {
  const list = $("#camerasList");
  list.innerHTML = "";
  const cams = configDoc.cameras || {};
  for (const [name, cam] of Object.entries(cams)) {
    list.append(cameraCard(name, cam));
  }
  setupCameraDnD();
}

// Reordenar câmeras por arrastar. collectCameras() lê os cards na ordem do DOM,
// então reordenar visualmente já persiste a nova ordem ao salvar.
function setupCameraDnD() {
  const list = $("#camerasList");
  if (list._dndReady) return;
  list._dndReady = true;
  list.addEventListener("dragover", (e) => {
    const dragging = list.querySelector(".list-item.dragging");
    if (!dragging) return;
    e.preventDefault();
    const after = cameraDragAfter(list, e.clientY);
    if (after == null) list.appendChild(dragging);
    else if (after !== dragging) list.insertBefore(dragging, after);
  });
}
function cameraDragAfter(list, y) {
  const items = [...list.querySelectorAll(".list-item:not(.dragging)")];
  let closest = { offset: -Infinity, el: null };
  for (const child of items) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}
(function injectDnDStyle() {
  const css = `
    .drag-handle { cursor: grab; color: var(--muted); padding: 0 8px 0 2px;
      user-select: none; font-size: 16px; line-height: 1; }
    .drag-handle:active { cursor: grabbing; }
    .list-item.dragging { opacity: .45; outline: 1px dashed var(--accent); }`;
  document.head.append(el("style", {}, css));
})();
function cameraCard(name, cam) {
  const nameInput = el("input", { type: "text", value: name });
  const enabledChk = el("input", { type: "checkbox" });
  enabledChk.checked = cam.enabled !== false;

  // ffmpeg inputs
  const inputsList = el("div", { class: "inputs-list" });
  const inputs = cam.ffmpeg?.inputs || [];
  const addInputRow = (inp = { path: "", roles: ["detect"] }) => {
    const pathEl = el("input", { type: "text", value: inp.path || "", placeholder: "rtsp://... ou restream" });
    const rolesWrap = el("div", { class: "roles" });
    const roles = new Set(inp.roles || []);
    FFMPEG_ROLES.forEach(r => {
      const chip = el("span", { class: "role-chk" + (roles.has(r) ? " on" : "") }, r);
      chip.onclick = () => {
        if (roles.has(r)) { roles.delete(r); chip.classList.remove("on"); }
        else { roles.add(r); chip.classList.add("on"); }
      };
      rolesWrap.append(chip);
    });
    const delBtn = el("button", { class: "btn danger", onclick: () => row.remove() }, "×");
    const row = el("div", { class: "input-row" }, pathEl, rolesWrap, delBtn);
    row._collect = () => {
      if (!pathEl.value.trim()) return null;
      return { path: pathEl.value.trim(), roles: [...roles] };
    };
    inputsList.append(row);
    return row;
  };
  inputs.forEach(addInputRow);

  const addInputBtn = el("button", { class: "btn ghost", onclick: () => addInputRow() }, "+ input");

  // detect / record / snapshots flags
  const detectEnabled = el("input", { type: "checkbox" });
  detectEnabled.checked = cam.detect?.enabled !== false;
  const detectW = el("input", { type: "number", value: cam.detect?.width ?? "" });
  const detectH = el("input", { type: "number", value: cam.detect?.height ?? "" });
  const detectFps = el("input", { type: "number", value: cam.detect?.fps ?? "" });

  const recordEnabled = el("input", { type: "checkbox" });
  recordEnabled.checked = cam.record?.enabled === true;
  const recordDays = el("input", { type: "number", value: get(cam, "record.retain.days", "") });

  const snapEnabled = el("input", { type: "checkbox" });
  snapEnabled.checked = cam.snapshots?.enabled === true;

  const motionMaskArea = el("textarea", { rows: 2, placeholder: "0,0,1000,0,1000,100,0,100" },
    Array.isArray(cam.motion?.mask) ? cam.motion.mask.join("\n") : (cam.motion?.mask || ""));

  const objectsArea = el("textarea", { rows: 3, placeholder: "person\ncar" },
    (cam.objects?.track || []).join("\n"));

  // zones
  const zonesArea = el("textarea", { rows: 4, class: "mono",
    placeholder: "# YAML de zones, ex:\n# entrada:\n#   coordinates: 0,0,100,0,100,100" },
    cam.zones ? jsyaml.dump(cam.zones) : "");

  const card = el("div", { class: "list-item" },
    el("div", { class: "list-item-head" },
      el("span", { class: "drag-handle", draggable: "true", title: "Arraste para reordenar" }, "⠿"),
      el("span", { class: "caret" }),
      el("span", { class: "name" }, name),
      el("span", { class: "badge " + (cam.enabled !== false ? "on" : "") },
        cam.enabled !== false ? "on" : "off"),
      el("button", {
        class: "btn danger",
        onclick: (e) => { e.stopPropagation(); if (confirm(`Remover câmera "${name}"?`)) card.remove(); }
      }, "Remover")
    ),
    el("div", { class: "list-item-body" },
      el("div", { class: "grid" },
        field("Nome", nameInput, null, "Identificador único da câmera. Use snake_case (ex: garagem, entrada_principal). Aparece na UI do Frigate."),
        field("Habilitada", labelChk(enabledChk, "ativa", "Se desligada, o Frigate ignora completamente esta câmera sem removê-la da config.")),
      ),
      headerWithTip("FFmpeg inputs", "Fontes de vídeo. Comum ter 2: stream principal (alta resolução) para gravação, sub-stream (baixa) para detecção. Ajuste roles para separar usos."),
      inputsList,
      addInputBtn,
      headerWithTip("Detecção", "Análise de objetos em tempo real. Sobrescreve o global para esta câmera."),
      el("div", { class: "grid" },
        field("Ativo", labelChk(detectEnabled, "detect", "Se ligado, o Frigate roda IA nos frames desta câmera.")),
        field("Width", detectW, null, "Largura (px) do stream usado para detecção. Menor = mais rápido, menos preciso. Típico: 1280."),
        field("Height", detectH, null, "Altura (px) do stream usado para detecção. Típico: 720."),
        field("FPS", detectFps, null, "Frames por segundo processados. Padrão recomendado: 5. Mais que isso = muito custo de CPU/TPU."),
      ),
      headerWithTip("Gravação", "Gravação em disco desta câmera. Sobrescreve a aba 'Padrão: Gravação'."),
      el("div", { class: "grid" },
        field("Ativo", labelChk(recordEnabled, "record", "Liga gravação para esta câmera. Precisa ter input com role 'record'.")),
        field("Retenção (dias)", recordDays, null, "Dias mantendo gravação contínua para esta câmera. Sobrescreve o padrão global."),
      ),
      headerWithTip("Snapshots", "JPG por evento detectado, só desta câmera. Sobrescreve a aba 'Padrão: Snapshots'."),
      el("div", { class: "grid" },
        field("Ativo", labelChk(snapEnabled, "snapshots", "Salva JPG dos eventos desta câmera.")),
      ),
      headerWithTip("Objetos (override)", "Lista só para esta câmera. Deixe vazio para herdar a lista da aba 'Padrão: Objetos'."),
      field("", objectsArea, "um por linha; vazio = usa global"),
      headerWithTip("Motion mask", "Regiões da imagem que o Frigate IGNORA para movimento (ex: rua movimentada, galho de árvore). Coordenadas normalizadas 0-1 no formato x,y,x,y,..."),
      field("", motionMaskArea, "uma máscara por linha (formato x,y,x,y,...)"),
      headerWithTip("Zones (YAML)", "Áreas nomeadas da imagem (ex: garagem, portão). Usadas para alertas só quando objeto entra nelas."),
      field("", zonesArea, "editar em YAML; deixe vazio se não houver zones"),
    )
  );
  card.querySelector(".list-item-head").onclick = (e) => {
    if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
    if (e.target.closest(".drag-handle")) return;
    card.classList.toggle("open");
  };

  // drag-and-drop para reordenar câmeras (a ordem no config = ordem no app Fire TV)
  const handle = card.querySelector(".drag-handle");
  handle.addEventListener("click", (e) => e.stopPropagation());
  handle.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", ""); } catch {}
  });
  handle.addEventListener("dragend", () => card.classList.remove("dragging"));

  card._collect = () => {
    const n = nameInput.value.trim();
    if (!n) return null;
    const out = { ...cam }; // preserve unknown keys
    out.enabled = enabledChk.checked;

    const ffInputs = [];
    $$(".input-row", inputsList).forEach(r => {
      const v = r._collect && r._collect();
      if (v) ffInputs.push(v);
    });
    out.ffmpeg = { ...(cam.ffmpeg || {}), inputs: ffInputs };

    out.detect = { ...(cam.detect || {}), enabled: detectEnabled.checked };
    if (detectW.value !== "") out.detect.width = Number(detectW.value); else delete out.detect.width;
    if (detectH.value !== "") out.detect.height = Number(detectH.value); else delete out.detect.height;
    if (detectFps.value !== "") out.detect.fps = Number(detectFps.value); else delete out.detect.fps;

    out.record = { ...(cam.record || {}), enabled: recordEnabled.checked };
    if (recordDays.value !== "") {
      out.record.retain = { ...(cam.record?.retain || { mode: "all" }), days: Number(recordDays.value) };
    }

    out.snapshots = { ...(cam.snapshots || {}), enabled: snapEnabled.checked };

    const objs = objectsArea.value.split("\n").map(l => l.trim()).filter(Boolean);
    if (objs.length) out.objects = { ...(cam.objects || {}), track: objs };
    else if (out.objects) delete out.objects.track;

    const maskLines = motionMaskArea.value.split("\n").map(l => l.trim()).filter(Boolean);
    if (maskLines.length) out.motion = { ...(cam.motion || {}), mask: maskLines.length === 1 ? maskLines[0] : maskLines };
    else if (out.motion) delete out.motion.mask;

    const zonesText = zonesArea.value.trim();
    if (zonesText) {
      try { out.zones = jsyaml.load(zonesText); }
      catch (e) { toast(`Zones YAML inválido na câmera ${n}: ${e.message}`, "err"); throw e; }
    } else {
      delete out.zones;
    }

    return [n, pruneEmpty(out)];
  };
  return card;
}
function collectCameras() {
  const out = {};
  $$("#camerasList .list-item").forEach(c => {
    const r = c._collect && c._collect();
    if (r) out[r[0]] = r[1];
  });
  configDoc.cameras = Object.keys(out).length ? out : undefined;
}
$("#addCameraBtn").onclick = () => {
  const name = prompt("Nome da nova câmera:", "camera_nova");
  if (!name) return;
  $("#camerasList").append(cameraCard(name, {
    enabled: true,
    ffmpeg: { inputs: [{ path: "", roles: ["detect"] }] },
    detect: { enabled: true },
  }));
};

// ---------- small dom helpers ----------
function tip(text) {
  return el("span", { class: "help", "data-tip": text }, "?");
}
function field(label, input, hint, tipText) {
  return el("div", {},
    label || tipText ? el("label", {}, label || "", tipText ? tip(tipText) : null) : null,
    input,
    hint ? el("p", { class: "hint" }, hint) : null
  );
}
function labelChk(input, text, tipText) {
  return el("label", { class: "chk" }, input, " ", text, tipText ? tip(tipText) : null);
}
function headerWithTip(text, tipText) {
  return el("h3", {}, text, tipText ? tip(tipText) : null);
}

// ---------- buttons ----------
$("#reloadBtn").onclick = () => loadConfig();
$("#saveBtn").onclick = () => saveConfig(false);
$("#saveRestartBtn").onclick = () => {
  if (confirm("Salvar e reiniciar o Frigate?")) saveConfig(true);
};

loadConfig();
