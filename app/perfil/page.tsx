"use client";

import { useState, useEffect } from "react";
import { FollowButton } from "../../components/perfil/FollowButton";

interface ProfileStats {
  followers: number;
  following: number;
}

interface UserProfile {
  id: string;
  name: string;
  handle: string;
  bio: string;
  stats: ProfileStats;
  isFollowing: boolean;
}

export default function PerfilPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // TODO: Replace with actual API call when #12 is merged
    // Mock data for local testing
    const mockProfile: UserProfile = {
      id: "user-123",
      name: "Curly Hair Enthusiast",
      handle: "@curlydev",
      bio: "Building the future of payment streams",
      stats: { followers: 42, following: 18 },
      isFollowing: false,
    };

    const timer = setTimeout(() => {
      setProfile(mockProfile);
      setIsLoading(false);
    }, 400);

    return () => clearTimeout(timer);
  }, []);

  const handleFollowChange = useCallback((isFollowing: boolean) => {
    setProfile((prev) => {
      if (!prev) return prev;
      const delta = isFollowing ? 1 : -1;
      return {
        ...prev,
        isFollowing,
        stats: {
          ...prev.stats,
          followers: Math.max(0, prev.stats.followers + delta),
        },
      };
    });
  }, []);

  if (isLoading) {
    return (
      <main className="perfil-page">
        <div className="perfil-page__skeleton" aria-busy="true" aria-label="Loading profile" />
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="perfil-page">
        <p className="perfil-page__error">Failed to load profile.</p>
      </main>
    );
  }

  return (
    <main className="perfil-page">
      <header className="perfil-page__header">
        <div className="perfil-page__avatar" aria-label={`${profile.name}'s avatar`} />
        <h1 className="perfil-page__name">{profile.name}</h1>
        <p className="perfil-page__handle">{profile.handle}</p>
        <p className="perfil-page__bio">{profile.bio}</p>

        <div className="perfil-page__stats">
          <div className="perfil-page__stat">
            <span className="perfil-page__stat-value" aria-live="polite">
              {profile.stats.followers}
            </span>
            <span className="perfil-page__stat-label">followers</span>
          </div>
          <div className="perfil-page__stat">
            <span className="perfil-page__stat-value" aria-live="polite">
              {profile.stats.following}
            </span>
            <span className="perfil-page__stat-label">following</span>
          </div>
        </div>

        <FollowButton
          userId={profile.id}
          initialIsFollowing={profile.isFollowing}
          onFollowChange={handleFollowChange}
        />
      </header>
    </main>
  );
}