import type { Metadata } from "next";
import HistoryApp from "./history-app";

export const metadata: Metadata = {
  title: "AgentHistory Viewer",
  description: "浏览本机 Codex 与 Claude Code 的历史对话。",
};

export default function Home() {
  return <HistoryApp />;
}
