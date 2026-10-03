fetch("/api/health").then((r) => r.json()).then((h) => {
  document.getElementById("version").textContent = `${h.version ?? "-"}（norm_v=${h.norm_v}）`;
  const repo = document.getElementById("repo");
  if (h.source) { repo.href = h.source; repo.textContent = h.source; }
}).catch(() => {});
