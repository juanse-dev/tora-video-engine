import {AbsoluteFill} from "remotion";

export const ToraVideo = () => {
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        backgroundColor: "#111827",
        color: "#f9fafb",
        display: "flex",
        fontFamily: "Arial, sans-serif",
        justifyContent: "center",
        padding: 96,
        textAlign: "center",
      }}
    >
      <div>
        <div
          style={{
            fontSize: 96,
            fontWeight: 700,
            letterSpacing: -3,
            lineHeight: 1,
          }}
        >
          Tora Video Engine
        </div>
        <div
          style={{
            fontSize: 42,
            lineHeight: 1.4,
            marginTop: 36,
            opacity: 0.72,
          }}
        >
          MVP-001 · Remotion is running
        </div>
      </div>
    </AbsoluteFill>
  );
};
