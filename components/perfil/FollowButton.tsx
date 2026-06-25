"use client";

import { useState, useCallback } from "react";

interface FollowButtonProps {
  userId: string;
  initialIsFollowing?: boolean;
  onFollowChange?: (isFollowing: boolean) => void;
}

export function FollowButton({
  userId,
  initialIsFollowing = false,
  onFollowChange,
}: FollowButtonProps) {
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing);
  const [isLoading, setIsLoading] = useState(false);

  const toggleFollow = useCallback(async () => {
    const nextState = !isFollowing;
    
    // Optimistic update
    setIsFollowing(nextState);
    onFollowChange?.(nextState);

    setIsLoading(true);
    try {
      // TODO: Replace with actual API call when #12 is merged
      // const res = await fetch(`/api/v1/users/${userId}/follow`, {
      //   method: nextState ? "POST" : "DELETE",
      //   headers: { "Content-Type": "application/json" },
      // });
      // if (!res.ok) throw new Error("Failed to update follow status");
      
      // Mock API delay for local testing
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (err) {
      // Rollback on error
      setIsFollowing(!nextState);
      onFollowChange?.(!nextState);
      console.error("Follow action failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [isFollowing, userId, onFollowChange]);

  return (
    <button
      type="button"
      onClick={toggleFollow}
      disabled={isLoading}
      className={`follow-button ${isFollowing ? "follow-button--following" : ""} ${
        isLoading ? "follow-button--loading" : ""
      }`}
      aria-pressed={isFollowing}
      aria-label={isFollowing ? `Unfollow user ${userId}` : `Follow user ${userId}`}
    >
      {isLoading ? (
        <span className="follow-button__spinner" aria-hidden="true" />
      ) : isFollowing ? (
        "Unfollow"
      ) : (
        "Follow"
      )}
    </button>
  );
}