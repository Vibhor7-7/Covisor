import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { updateSettings, useSettings, type Settings } from "../settings";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="setting">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

/** Saves when you leave the field or press Enter, not on every keystroke. */
function TextField({
  name,
  placeholder,
  disabled,
}: {
  name: "agentId" | "apiUrl";
  placeholder: string;
  disabled?: boolean;
}) {
  const settings = useSettings();
  return (
    <input
      key={settings[name]}
      defaultValue={settings[name]}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      onBlur={(event) => updateSettings({ [name]: event.target.value.trim() })}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
    />
  );
}

const APPEARANCES: Array<{ value: Settings["appearance"]; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type Props = { open: boolean; onClose: () => void; busy: boolean };

/** `busy` locks the fields that would cut off a live call or run. */
export function SettingsDialog({ open, onClose, busy }: Props) {
  const settings = useSettings();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current!;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="settings"
      aria-label="Settings"
      onClose={onClose}
      onClick={(event) => event.target === dialog.current && onClose()}
    >
      <header>
        <h2>Settings</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close settings">
          <X />
        </button>
      </header>

      <h3>Voice</h3>
      <div className="setting-group">
        <Row label="ElevenLabs agent ID" hint="Leave empty to play the scripted call.">
          <TextField name="agentId" placeholder="agent_…" disabled={busy} />
        </Row>
        <Row label="Read the run log aloud">
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={settings.narration}
            onClick={() => updateSettings({ narration: !settings.narration })}
          />
        </Row>
      </div>

      <h3>Connection</h3>
      <div className="setting-group">
        <Row label="Backend">
          <TextField name="apiUrl" placeholder="http://localhost:3001" disabled={busy} />
        </Row>
      </div>

      <h3>Appearance</h3>
      <div className="setting-group">
        <div className="setting">
          <span>Theme</span>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {APPEARANCES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={settings.appearance === value}
                onClick={() => updateSettings({ appearance: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </dialog>
  );
}
