import { useEffect, useState } from "react";
import { isPinSet, setPin, verifyPin, markUnlocked } from "../lib/pin";

export default function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [mode, setMode] = useState<"loading" | "setup" | "enter">("loading");
  const [pin, setPinValue] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    isPinSet().then((set) => setMode(set ? "enter" : "setup"));
  }, []);

  async function handleSetup() {
    if (pin.length < 4) return setError("PIN must be at least 4 digits");
    if (pin !== confirmPin) return setError("PINs don't match");
    await setPin(pin);
    markUnlocked();
    onUnlock();
  }

  async function handleEnter() {
    const ok = await verifyPin(pin);
    if (!ok) {
      setError("Wrong PIN");
      setPinValue("");
      return;
    }
    markUnlocked();
    onUnlock();
  }

  if (mode === "loading") return null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 bg-gray-50">
      <h1 className="text-2xl font-bold text-brand">Niko-Payroll</h1>
      <p className="text-sm text-gray-500">{mode === "setup" ? "Set a PIN to protect this device" : "Enter PIN to unlock"}</p>

      <input
        type="password"
        inputMode="numeric"
        value={pin}
        onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
        placeholder="PIN"
        className="w-40 text-center text-xl tracking-widest border rounded-lg px-3 py-3"
        autoFocus
      />
      {mode === "setup" && (
        <input
          type="password"
          inputMode="numeric"
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
          placeholder="Confirm PIN"
          className="w-40 text-center text-xl tracking-widest border rounded-lg px-3 py-3"
        />
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        onClick={mode === "setup" ? handleSetup : handleEnter}
        className="w-40 py-3 rounded-lg bg-brand text-white font-medium"
      >
        {mode === "setup" ? "Set PIN" : "Unlock"}
      </button>
    </div>
  );
}
