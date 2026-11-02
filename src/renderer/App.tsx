import { useEffect, useRef } from "react";
import { platform } from "./api";
import { ControlPanel } from "./components/ControlPanel";
import { FavoriteEditor, RouteNamer, ScheduleEditor } from "./components/Editors";
import { MapView } from "./components/MapView";
import { Onboarding } from "./components/Onboarding";
import { ConfirmDialog, IntroSplash, SimBanner, Toasts } from "./components/Overlays";
import type { SearchHandle } from "./components/SearchBox";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { useResolvedTheme } from "./lib/useTheme";
import { stopSimulation, useStore } from "./store";

export function App() {
  const theme = useResolvedTheme();
  const ready = useStore((s) => s.ready);
  const intro = useStore((s) => s.introVisible);
  const maximized = useStore((s) => s.windowMaximized);
  const searchRef = useRef<SearchHandle | null>(null);
  const square = platform !== "darwin" || maximized;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.setState({ sidebarOpen: true });
        setTimeout(() => searchRef.current?.focus(), useStore.getState().sidebarOpen ? 0 : 260);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        useStore.setState((s) => ({ sidebarOpen: !s.sidebarOpen }));
      } else if (mod && e.key === ".") {
        e.preventDefault();
        void stopSimulation();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useStore.setState({ settingsOpen: "general" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) return <div className={`app ${square ? "square" : ""}`} />;

  return (
    <>
      <div className={`app ${square ? "square" : ""}`} data-testid="app">
        <TitleBar />
        <div className="body">
          <Sidebar searchRef={searchRef} />
          <main className="stage" aria-label="Map">
            <MapView dark={theme === "dark"} />
            <SimBanner />
            <ControlPanel />
          </main>
        </div>
      </div>
      <SettingsDialog />
      <Onboarding />
      <FavoriteEditor />
      <RouteNamer />
      <ScheduleEditor />
      <ConfirmDialog />
      <Toasts placement="overlay" />
      {intro && (
        <IntroSplash
          light={theme === "light"}
          square={square}
          onDone={() => {
            const s = useStore.getState();
            useStore.setState({ introVisible: false, onboardingOpen: !s.settings.onboarding.completedAt });
          }}
        />
      )}
    </>
  );
}
