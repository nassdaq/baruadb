/** A stable-enough signature of this browser, hashed, sent once at sign-up.
 *  It is not identity and never decides anything alone: the control plane
 *  pairs it with a long-lived cookie, and the only consequence of a match is
 *  that a second account from the same device starts without a free
 *  allowance until a person looks. Any failure here just sends nothing. */
export async function deviceSignature(): Promise<string | undefined> {
  try {
    const n = navigator;
    const parts = [
      n.userAgent,
      n.platform,
      (n.languages ?? [n.language]).join(","),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      `${screen.width}x${screen.height}x${screen.colorDepth}@${devicePixelRatio}`,
      String(n.hardwareConcurrency ?? ""),
      String(n.maxTouchPoints ?? ""),
      canvasSample(),
    ];
    const bytes = new TextEncoder().encode(parts.join("|"));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

function canvasSample(): string {
  const c = document.createElement("canvas");
  c.width = 200;
  c.height = 40;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.textBaseline = "top";
  ctx.font = "16px Outfit, sans-serif";
  ctx.fillStyle = "#186F70";
  ctx.fillRect(0, 0, 60, 20);
  ctx.fillStyle = "#C2453D";
  ctx.fillText("Barua Database", 4, 4);
  ctx.strokeStyle = "#60a5fa";
  ctx.arc(150, 20, 12, 0, Math.PI * 1.5);
  ctx.stroke();
  return c.toDataURL();
}
