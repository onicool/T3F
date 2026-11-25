import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

export const isCodexDriverKind = (
  driverKind: ProviderDriverKind | undefined,
): boolean => driverKind === CODEX_DRIVER_KIND;

export class ProjectProviderLockedError extends Schema.TaggedError<ProjectProviderLockedError>()(
  "ProjectProviderLockedError",
  {
    projectId: ProjectId,
    projectTitle: Schema.optional(Schema.String),
    instanceId: ProviderInstanceId,
    driverKind: Schema.optional(ProviderDriverKind),
  },
) {
  override get message(): string {
    const project =
      this.projectTitle === undefined ? `${this.projectId}` : `"${this.projectTitle}"`;
    return `Project ${project} contains personal information and can only run with Codex; provider instance "${this.instanceId}" is not a Codex instance.`;
  }
}

export const isProjectProviderLockedError = Schema.is(ProjectProviderLockedError);

export interface ProjectProviderLockShape {
  /** True when the project is flagged as containing personal information. */
  readonly isProjectLocked: (projectId: ProjectId) => Effect.Effect<boolean>;
  /** True when the project is locked and the instance does not resolve to a Codex driver. */
  readonly isLockedOut: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
  readonly assertAllowed: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void, ProjectProviderLockedError>;
}

export class ProjectProviderLock extends Context.Service<
  ProjectProviderLock,
  ProjectProviderLockShape
>()("t3/orchestration-v2/ProjectProviderLock") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  // A lock that cannot be read must not silently open: unreadable state counts as locked.
  const projectLockState = (
    projectId: ProjectId,
  ): Effect.Effect<{ readonly locked: boolean; readonly title: string | undefined }> =>
    projects.get(projectId).pipe(
      Effect.map((row) =>
        Option.isSome(row)
          ? { locked: row.value.containsPersonalInfo === true, title: row.value.title }
          : { locked: false, title: undefined },
      ),
      Effect.orElseSucceed(() => ({ locked: true, title: undefined })),
    );

  const isProjectLocked: ProjectProviderLockShape["isProjectLocked"] = Effect.fn(
    "ProjectProviderLock.isProjectLocked",
  )(function (projectId) {
    return projectLockState(projectId).pipe(Effect.map((state) => state.locked));
  });

  const driverKindOf = (instanceId: ProviderInstanceId) =>
    providerInstances
      .getInstance(instanceId)
      .pipe(Effect.map((instance) => instance?.driverKind));

  const isLockedOut: ProjectProviderLockShape["isLockedOut"] = Effect.fn(
    "ProjectProviderLock.isLockedOut",
  )(function* (input) {
    if (!(yield* isProjectLocked(input.projectId))) return false;
    return !isCodexDriverKind(yield* driverKindOf(input.instanceId));
  });

  const assertAllowed: ProjectProviderLockShape["assertAllowed"] = Effect.fn(
    "ProjectProviderLock.assertAllowed",
  )(function* (input) {
    const state = yield* projectLockState(input.projectId);
    if (!state.locked) return;
    const driverKind = yield* driverKindOf(input.instanceId);
    if (isCodexDriverKind(driverKind)) return;
    return yield* new ProjectProviderLockedError({
      projectId: input.projectId,
      ...(state.title === undefined ? {} : { projectTitle: state.title }),
      instanceId: input.instanceId,
      ...(driverKind === undefined ? {} : { driverKind }),
    });
  });

  return ProjectProviderLock.of({ isProjectLocked, isLockedOut, assertAllowed });
});

export const layer: Layer.Layer<
  ProjectProviderLock,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(ProjectProviderLock, make);
