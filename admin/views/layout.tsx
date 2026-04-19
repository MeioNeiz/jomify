/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";

type Props = {
  title: string;
  username: string;
  csrf: string;
  flash?: string;
  children?: Child;
};

const Layout: FC<Props> = ({ title, username, csrf, flash, children }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} — Jomify Admin</title>
      {/* @ts-ignore */}
      <script src="https://cdn.tailwindcss.com" />
    </head>
    <body class="bg-gray-950 text-gray-100 min-h-screen font-sans">
      <nav class="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center gap-6 text-sm">
        <a href="/" class="font-bold text-pink-400 hover:text-pink-300">
          Jomify Admin
        </a>
        <a href="/markets" class="text-gray-300 hover:text-white">
          Markets
        </a>
        <a href="/disputes" class="text-gray-300 hover:text-white">
          Disputes
        </a>
        <a href="/users" class="text-gray-300 hover:text-white">
          Users
        </a>
        <a href="/ledger" class="text-gray-300 hover:text-white">
          Ledger
        </a>
        <div class="ml-auto flex items-center gap-4">
          <span class="text-gray-400">{username}</span>
          <a href="/logout" class="text-gray-500 hover:text-white">
            Logout
          </a>
        </div>
      </nav>
      <main class="px-6 py-6 max-w-7xl mx-auto">
        {flash && (
          <div class="mb-4 bg-green-900 border border-green-700 text-green-200 px-4 py-2 rounded text-sm">
            {flash}
          </div>
        )}
        {children}
      </main>
      {/* Hidden CSRF value for in-page forms that need it */}
      <template id="csrf-token" data-token={csrf} />
    </body>
  </html>
);

export function page(
  title: string,
  username: string,
  csrf: string,
  children: Child,
  flash?: string,
) {
  return (
    <Layout title={title} username={username} csrf={csrf} flash={flash}>
      {children}
    </Layout>
  );
}
