import ParticleCanvas from "@/components/ParticleCanvas";
import { Launcher }   from "@/components/Launcher";
import { CursorRing } from "@/components/CursorRing";

// One page, three roles chosen by query string:
//   (none)      browser-version launcher (bubble wand)
//   ?launched=1 a bubble window
//   ?ring=1     Electron blow-mode cursor ring
export default function Home() {
  return (
    <main style={{ width: "100vw", height: "100vh", background: "#000", overflow: "hidden" }}>
      <ParticleCanvas />
      <Launcher />
      <CursorRing />
    </main>
  );
}
