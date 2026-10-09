import ParticleCanvas from "@/components/ParticleCanvas";

export default function Home() {
  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        background: "#000000",
        overflow: "hidden",
      }}
    >
      <ParticleCanvas />
    </main>
  );
}
