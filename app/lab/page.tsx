import { notFound } from "next/navigation";
import Lab from "./Lab";

// Development-only test bench: exposes the engine on window for scripted checks.
export default function LabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Lab />;
}
