async function showLocalStatus() {
  try {
    const response = await fetch("/api/local-status");
    if (!response.ok) return;
    const status = await response.json();
    const banner = document.getElementById("local-setup-status") || document.createElement("aside");
    banner.id = "local-setup-status";
    banner.setAttribute("role", "status");
    banner.textContent = status.message;
    const link=document.createElement('a');link.href='/setup.html';link.textContent='首次配置 / 修改中继';link.style.marginLeft='12px';banner.append(link);
    Object.assign(banner.style, {
      margin: "12px 0", padding: "12px 16px", borderRadius: "12px",
      border: "1px solid rgba(73,211,167,.35)", background: "rgba(73,211,167,.08)",
      color: "inherit", fontSize: "13px", lineHeight: "1.6", flexShrink: "0"
    });
    // The home page's main element is a three-column grid. Keep the notice
    // inside its existing sidebar instead of adding a fourth grid item.
    if (!banner.isConnected) (document.querySelector(".instance-panel") || document.querySelector("main") || document.body).prepend(banner);
  } catch { /* the existing page reports server connectivity failures */ }
}
showLocalStatus();
window.addEventListener("focus", showLocalStatus);

fetch('/api/setup').then(response=>response.json()).then(result=>{if(!result.configured)location.replace('/setup.html');}).catch(()=>{});
