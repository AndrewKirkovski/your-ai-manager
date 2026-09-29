/** The revision is baked into the bot image by the release workflow. */
export function releaseRevision(value = process.env.BOT_IMAGE_REVISION): string | null {
    return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

export function releaseVersionReply(challenge?: string, revision = releaseRevision()): string {
    const version = revision ? `Running bot revision: ${revision}` : 'Bot image revision is unavailable.';
    return challenge ? `${version}\nChallenge: ${challenge}` : version;
}
