import ParticleCanvas from "@/components/ParticleCanvas";
import { LaunchButton }  from "@/components/LaunchButton";
import { RandomWalker }  from "@/components/RandomWalker";

export default function Home() {
  return (
    <main style={{ width: "100vw", height: "100vh", background: "#000", overflow: "hidden" }}>
      <ParticleCanvas />
      <LaunchButton />
      <RandomWalker />
    </main>
  );
}
