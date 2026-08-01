import { USER_AVATAR_IDS } from "@zimlo/protocol";
import type { UserAvatarId } from "@zimlo/protocol";

interface UserAvatarProps {
  avatarId: UserAvatarId;
  className?: string;
  alt?: string;
}

export function userAvatarSrc(avatarId: UserAvatarId): string {
  return `/avatars/${avatarId}.png`;
}

export function UserAvatar({ avatarId, className = "", alt = "用户头像" }: UserAvatarProps) {
  return <img className={`user-avatar-image ${className}`.trim()} src={userAvatarSrc(avatarId)} alt={alt} />;
}

export function isPresetAvatar(avatar: string): avatar is UserAvatarId {
  return USER_AVATAR_IDS.includes(avatar as UserAvatarId);
}

export function AgentAvatar({ avatar, className = "", alt = "Agent 头像" }: { avatar: string; className?: string; alt?: string }) {
  if (isPresetAvatar(avatar)) {
    return <img className={`agent-avatar-image ${className}`.trim()} src={userAvatarSrc(avatar)} alt={alt} />;
  }
  return <span className={className} aria-hidden={alt === ""} aria-label={alt || undefined}>{avatar}</span>;
}

export function ZimloAvatar({ className = "", alt = "Zimlo" }: Omit<UserAvatarProps, "avatarId">) {
  return <img className={`zimlo-avatar-image ${className}`.trim()} src="/zimlo-icon.svg?brand=2" alt={alt} />;
}
