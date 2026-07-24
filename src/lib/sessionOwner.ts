export type SessionTurnOwner = "idle" | "text" | "voice";

/**
 * Application-level single owner for model-driven response/tool loops.
 * Voice connection may stay open while text owns the turn.
 */
export class SessionOwnerLock {
  private owner: SessionTurnOwner = "idle";
  private voiceBusy = false;

  getOwner(): SessionTurnOwner {
    return this.owner;
  }

  isVoiceBusy(): boolean {
    return this.voiceBusy;
  }

  setVoiceBusy(busy: boolean): void {
    this.voiceBusy = busy;
    if (busy && this.owner === "idle") {
      this.owner = "voice";
    }
    if (!busy && this.owner === "voice") {
      this.owner = "idle";
    }
  }

  tryAcquireText(): { ok: true } | { ok: false; message: string } {
    if (this.owner === "voice" || this.voiceBusy) {
      return { ok: false, message: "Jarvis is busy with a voice response." };
    }
    if (this.owner === "text") {
      return { ok: false, message: "Jarvis is busy with another text turn." };
    }
    this.owner = "text";
    return { ok: true };
  }

  releaseText(): void {
    if (this.owner === "text") {
      this.owner = this.voiceBusy ? "voice" : "idle";
    }
  }

  canStartVoiceResponse(): boolean {
    return this.owner !== "text";
  }
}
