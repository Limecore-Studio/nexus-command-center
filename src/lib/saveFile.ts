// v1.21.1 (limecore#103) — write a text file the user can find afterwards.
//
// Android: the native LimecoreSaveFile plugin opens the system "create
// document" picker; an Android WebView silently ignores <a download>, which
// is why the export used to say "Saved" while writing nothing. Web and the
// desktop app keep the anchor download, which works there.
//
// Returns true when the file was written (or handed to the browser), false
// when the user cancelled the picker. Throws when writing failed.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface SaveFileApi {
  save(opts: { name: string; data: string; mimeType?: string }): Promise<{ saved: boolean }>;
}

const LimecoreSaveFile = registerPlugin<SaveFileApi>('LimecoreSaveFile');

export async function saveTextFile(name: string, data: string, mimeType = 'application/json'): Promise<boolean> {
  if (Capacitor.getPlatform() === 'android') {
    const { saved } = await LimecoreSaveFile.save({ name, data, mimeType });
    return saved;
  }
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later: revoking at once can cancel a download before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
