const { IOSConfig, withXcodeProject } = require("@expo/config-plugins");

const DEV_LAUNCHER_PHASE =
  "[Expo Dev Launcher] Strip Local Network Keys for Release";

function trimQuotes(value) {
  return String(value ?? "").replace(/^"(.*)"$/, "$1");
}

/**
 * Keep local physical-device builds on Xcode-managed signing.
 *
 * Expo writes the development team into build settings, but an existing native
 * project can still retain manual signing. That prevents Xcode from creating a
 * provisioning profile when `expo run:ios --device` is used.
 */
module.exports = function withAutomaticIosSigning(config) {
  return withXcodeProject(config, (configWithProject) => {
    const project = configWithProject.modResults;
    const appleTeamId = configWithProject.ios?.appleTeamId;
    const projectAttributes = project.getFirstProject().firstProject;

    projectAttributes.attributes ??= {};
    projectAttributes.attributes.TargetAttributes ??= {};

    for (const [targetId, target] of IOSConfig.Target.getNativeTargets(project)) {
      const targetAttributes =
        (projectAttributes.attributes.TargetAttributes[targetId] ??= {});

      targetAttributes.ProvisioningStyle = "Automatic";
      if (appleTeamId) {
        targetAttributes.DevelopmentTeam = appleTeamId;
      }

      for (const [, buildConfiguration] of
        IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
          project,
          target.buildConfigurationList,
        )) {
        buildConfiguration.buildSettings.CODE_SIGN_STYLE = "Automatic";
        delete buildConfiguration.buildSettings.PROVISIONING_PROFILE;
        delete buildConfiguration.buildSettings.PROVISIONING_PROFILE_SPECIFIER;

        if (appleTeamId) {
          buildConfiguration.buildSettings.DEVELOPMENT_TEAM = appleTeamId;
        }
      }
    }

    const shellScriptPhases =
      project.hash.project.objects.PBXShellScriptBuildPhase ?? {};

    for (const phase of Object.values(shellScriptPhases)) {
      if (
        phase &&
        typeof phase === "object" &&
        trimQuotes(phase.name) === DEV_LAUNCHER_PHASE
      ) {
        // This generated phase intentionally evaluates every build. Marking it
        // explicit removes Xcode's ambiguous-dependencies warning.
        phase.alwaysOutOfDate = 1;
      }
    }

    return configWithProject;
  });
};
