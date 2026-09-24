/**
 * Copy text, on any origin a box is reached at.
 *
 * `navigator.clipboard` exists only in a secure context — https, or localhost. A Nouride Box is
 * opened at `http://<lan ip>:<port>`, where it is `undefined`, so every copy button on the first box
 * threw before doing anything and looked dead. The fallback is the old selection + `execCommand`,
 * which still works on plain http. Resolves to whether the copy happened.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission, or a browser that lies about the secure context — try the fallback.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}
