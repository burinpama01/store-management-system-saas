import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Sidebar — implemented in Package O */}
      <aside className="w-56 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="p-4 border-b border-gray-100">
          <span className="text-sm font-semibold text-gray-700">Store Manager</span>
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {/* Nav links added in Package O */}
        </nav>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-12 border-b border-gray-200 bg-white px-4 flex items-center shrink-0">
          {/* Topbar / store switcher — Package E */}
        </header>
        <main className="flex-1 overflow-y-auto p-4">
          {children}
        </main>
      </div>
    </div>
  );
}
