// Pure presentation decisions for the terminal dispatch receipt. Kept outside
// content.js so permission exceptions can be tested without a browser DOM.
(function (global) {
  const SCOPE_FOR_CAPABILITY = {
    push_current_pr: ["current_pr", "PR"],
    update_current_pr: ["current_pr", "PR"],
    create_repo_issue: ["current_repo", "repository"],
    request_repo_reviewer: ["current_repo", "repository"],
    update_repo_metadata: ["current_repo", "repository"],
    call_connected_service: ["connected_services", "connected services"],
  };

  function blockedEffectsOf(result) {
    return (result?.actionPlan?.actions || [])
      .flatMap((action) => action.effects || [])
      .filter((effect) => effect.authorization === "required");
  }

  function deriveReceipt(result = {}, streamedBlockedEffect = null) {
    const effects = blockedEffectsOf(result);
    const blockedCount = result.actionSummary?.blockedEffects || effects.length || 0;
    const labels = effects.map((effect) => effect.summary || effect.capability).filter(Boolean);
    if (!labels.length && streamedBlockedEffect) labels.push(streamedBlockedEffect);
    const primaryEffect = effects[0];
    const scope = primaryEffect && SCOPE_FOR_CAPABILITY[primaryEffect.capability];
    const published = result.published === true;
    const localRetained = result.localWorkspaceRetained === true ||
      (result.published === false && (result.commits?.length || 0) > 0);

    return {
      permissionBlocked: blockedCount > 0,
      blockedCount,
      published,
      localRetained,
      canRefresh: published && (result.commits?.length || 0) > 0,
      effectLabel: labels.length
        ? `${labels.join(labels.length > 2 ? ", " : " and ")}${blockedCount > labels.length ? ` and ${blockedCount - labels.length} more` : ""}`
        : "A requested effect",
      retentionText: localRetained
        ? "Your completed work remains in the local workspace."
        : published
          ? "The pull request update was published; this additional effect was not run."
          : "Authorized work completed; this effect was not run.",
      nextScope: scope?.[0] || null,
      nextLabel: scope ? `Use ${scope[1]} scope next session` : null,
    };
  }

  global.VoicePrReceipt = { blockedEffectsOf, deriveReceipt };
})(typeof globalThis !== "undefined" ? globalThis : window);
