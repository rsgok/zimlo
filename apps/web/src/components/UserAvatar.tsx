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

export function ZimloAvatar({ className = "", alt = "Zimlo" }: Omit<UserAvatarProps, "avatarId">) {
  return <img className={`zimlo-avatar-image ${className}`.trim()} src="/avatars/zimlo.png" alt={alt} />;
}
