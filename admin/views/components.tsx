/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import type { IpcChannel } from "../ipc.js";

// ── Status badges ────────────────────────────────────────────────────

const STATUS_COLOURS: Record<string, string> = {
  open: "bg-green-900 text-green-300",
  resolved: "bg-blue-900 text-blue-300",
  cancelled: "bg-gray-700 text-gray-300",
};

export const Badge: FC<{ status: string }> = ({ status }) => (
  <span
    class={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLOURS[status] ?? "bg-gray-700 text-gray-300"}`}
  >
    {status}
  </span>
);

// ── Table ────────────────────────────────────────────────────────────

export const Table: FC<{
  headers: string[];
  children?: Child;
}> = ({ headers, children }) => (
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead class="text-gray-400 border-b border-gray-800">
        <tr>
          {headers.map((h) => (
            <th class="text-left py-2 pr-4 font-medium whitespace-nowrap">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-800/50">{children}</tbody>
    </table>
  </div>
);

export const Tr: FC<{ children?: Child }> = ({ children }) => (
  <tr class="hover:bg-gray-900/50">{children}</tr>
);

export const Td: FC<{ children?: Child; mono?: boolean }> = ({ children, mono }) => (
  <td class={`py-2 pr-4 align-top ${mono ? "font-mono text-xs" : ""}`}>{children}</td>
);

// ── Section heading ───────────────────────────────────────────────────

export const H1: FC<{ children?: Child }> = ({ children }) => (
  <h1 class="text-xl font-bold mb-4">{children}</h1>
);

export const H2: FC<{ children?: Child }> = ({ children }) => (
  <h2 class="text-base font-semibold mb-3 text-gray-300">{children}</h2>
);

// ── Cards ─────────────────────────────────────────────────────────────

export const Card: FC<{ children?: Child; class?: string }> = ({
  children,
  class: cls,
}) => (
  <div class={`bg-gray-900 border border-gray-800 rounded-lg p-4 ${cls ?? ""}`}>
    {children}
  </div>
);

export const Stat: FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div class="text-center">
    <div class="text-2xl font-bold">{value}</div>
    <div class="text-xs text-gray-400 mt-1">{label}</div>
  </div>
);

// ── Pagination ────────────────────────────────────────────────────────

export const Pagination: FC<{
  page: number;
  total: number;
  pageSize: number;
  url: string;
}> = ({ page, total, pageSize, url }) => {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;
  const prev = page > 1 ? page - 1 : null;
  const next = page < totalPages ? page + 1 : null;
  return (
    <div class="flex gap-2 mt-4 text-sm text-gray-400">
      {prev && (
        <a href={`${url}?page=${prev}`} class="hover:text-white">
          ← Previous
        </a>
      )}
      <span class="mx-2">
        {page} / {totalPages}
      </span>
      {next && (
        <a href={`${url}?page=${next}`} class="hover:text-white">
          Next →
        </a>
      )}
    </div>
  );
};

// ── Forms ─────────────────────────────────────────────────────────────

export const HiddenCsrf: FC<{ token: string }> = ({ token }) => (
  <input type="hidden" name="_csrf" value={token} />
);

export const Btn: FC<{
  label: string;
  name?: string;
  value?: string;
  variant?: "danger" | "primary" | "ghost";
}> = ({ label, name, value, variant = "primary" }) => {
  const colours = {
    primary: "bg-pink-700 hover:bg-pink-600 text-white",
    danger: "bg-red-800 hover:bg-red-700 text-white",
    ghost: "bg-gray-700 hover:bg-gray-600 text-gray-200",
  };
  return (
    <button
      type="submit"
      name={name}
      value={value}
      class={`px-3 py-1.5 rounded text-sm font-medium ${colours[variant]}`}
    >
      {label}
    </button>
  );
};

// ── Helpers ──────────────────────────────────────────────────────────

export function fmtDate(s: string | null): string {
  if (!s) return "—";
  return s.replace("T", " ").slice(0, 16);
}

export function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ── Channel picker ───────────────────────────────────────────────────
// Renders a <select> of the guild's text/announcement channels when the
// bot loopback answers, or a text input fallback when it doesn't. Used
// by /settings and the create-market form.
export const ChannelPicker: FC<{
  channels: IpcChannel[];
  current?: string | null;
  name?: string;
  id?: string;
  includeNone?: boolean;
  noneLabel?: string;
  fallbackPlaceholder?: string;
  fallbackHint?: string;
}> = ({
  channels,
  current,
  name = "notify_channel_id",
  id = name,
  includeNone = true,
  noneLabel = "(none — disable notifications)",
  fallbackPlaceholder = "e.g. 123456789012345678",
  fallbackHint = "Bot isn't reachable or isn't in this guild — paste a channel ID manually.",
}) => {
  if (channels.length === 0) {
    return (
      <>
        <input
          id={id}
          type="text"
          name={name}
          value={current ?? ""}
          class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white font-mono"
          placeholder={fallbackPlaceholder}
        />
        <p class="text-xs text-gray-500 mt-1">{fallbackHint}</p>
      </>
    );
  }
  return (
    <select
      id={id}
      name={name}
      class="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm w-full text-white"
    >
      {includeNone && <option value="">{noneLabel}</option>}
      {channels.map((ch) => (
        <option value={ch.id} selected={ch.id === current}>
          #{ch.name}
          {ch.parentName ? ` · ${ch.parentName}` : ""}
        </option>
      ))}
    </select>
  );
};
