// T3F fork: telemetry is permanently disabled. The AnalyticsService
// interface is unchanged so every call site keeps working, but this layer
// is a no-op: it never reads provider auth files, never builds a telemetry
// identity, and never sends anything to PostHog or ingest.t3.codes.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;

    /**
     * Records `install.owner_observed` for each owner of this install that the
     * server read itself or a connecting client reported. Each owner is sent once
     * per server process, so reconnects and repeated reads are free.
     */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

export const make = Effect.succeed(
  AnalyticsService.of({
    record: () => Effect.void,
    flush: Effect.void,
    recordOwners: () => Effect.void,
  }),
);

export const layer = Layer.effect(AnalyticsService, make);
