import Studio from "@/components/Studio";

/**
 * The tools. The layout renders the whole app and stays mounted while the
 * address switches between /edit and /icons, so neither tool loses its work.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Studio />
      {children}
    </>
  );
}
