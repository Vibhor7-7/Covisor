import { X } from "lucide-react";
import { useCall } from "../call/call";
import type { ListField, TextField } from "../spec";
import { useStore } from "../store";

const GROUPS: Array<{ field: ListField; label: string; add: string }> = [
  { field: "decisions", label: "Decisions", add: "Add a decision" },
  { field: "scopeIn", label: "In scope", add: "Add to scope" },
  { field: "scopeOut", label: "Out of scope", add: "Rule something out" },
  { field: "constraints", label: "Constraints", add: "Add a constraint" },
  { field: "acceptance", label: "Done when", add: "Add a check" },
  { field: "openQuestions", label: "Open questions", add: "Add a question" },
];

type EditableProps = {
  value: string;
  placeholder: string;
  locked: boolean;
  className?: string;
  onCommit: (text: string) => void;
};

/** Text you edit in place: click to edit, Enter or click away to save, Esc to undo. */
function Editable({ value, placeholder, locked, className = "", onCommit }: EditableProps) {
  return (
    <span
      className={`editable ${className}`}
      role="textbox"
      aria-label={placeholder}
      aria-readonly={locked}
      contentEditable={locked ? false : "plaintext-only"}
      suppressContentEditableWarning
      data-placeholder={locked ? "" : placeholder}
      onBlur={(event) => {
        const text = event.currentTarget.textContent?.trim() ?? "";
        if (text !== value) onCommit(text);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.currentTarget.textContent = value;
          event.currentTarget.blur();
        }
      }}
    >
      {value}
    </span>
  );
}

/**
 * Everything decided so far, editable until the build starts. A field the
 * founder edits by hand stays as edited, and Max is told about the change.
 */
export function Decisions() {
  const { state, dispatch } = useStore();
  const call = useCall();
  const { spec } = state;
  const locked = state.runId !== null;

  const save = (field: TextField | ListField, label: string, value: string | string[]) => {
    dispatch({ type: "specEdit", field, value });
    const now = Array.isArray(value) ? value.join("; ") : value;
    call.tell(
      `The founder edited the spec by hand. "${label}" is now: ${now || "empty"}. Keep it exactly like this.`,
    );
  };

  const text = (field: TextField, label: string, className: string) => (
    <Editable
      key={spec[field]}
      className={className}
      value={spec[field] ?? ""}
      placeholder={label}
      locked={locked}
      onCommit={(next) => save(field, label, next)}
    />
  );

  return (
    <div className="decisions">
      {text("title", "Name this plan", "decisions-title")}
      {text("goal", "What is the goal?", "decisions-goal")}
      {text("user", "Who is it for?", "decisions-goal")}

      {GROUPS.map(({ field, label, add }) => {
        const items = spec[field] ?? [];
        const set = (next: string[]) => save(field, label, next);
        return (
          <section key={field}>
            <h3>{label}</h3>
            <ul>
              {items.map((item, i) => (
                <li key={`${i}:${item}`}>
                  <Editable
                    value={item}
                    placeholder={add}
                    locked={locked}
                    // Saving an emptied item removes it.
                    onCommit={(next) => set(next ? items.with(i, next) : items.toSpliced(i, 1))}
                  />
                  {!locked && (
                    <button
                      className="icon-button"
                      onClick={() => set(items.toSpliced(i, 1))}
                      aria-label={`Remove "${item}"`}
                    >
                      <X />
                    </button>
                  )}
                </li>
              ))}
              {!locked && (
                <li className="is-new" key={`new:${items.length}`}>
                  <Editable
                    value=""
                    placeholder={add}
                    locked={false}
                    onCommit={(next) => set([...items, next])}
                  />
                </li>
              )}
              {locked && items.length === 0 && <li className="empty">None</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
