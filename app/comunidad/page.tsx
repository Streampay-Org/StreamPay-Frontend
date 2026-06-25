"use client";

import { useState, useEffect, useCallback } from "react";

type FeedTab = "all" | "following";

interface Post {
  id: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  content: string;
  createdAt: string;
  isFollowing: boolean;
}

const MOCK_POSTS: Post[] = [
  {
    id: "1",
    authorId: "user-1",
    authorName: "Alice Curls",
    authorHandle: "@alicecurls",
    content: "Just defined my wash day routine! 🌀",
    createdAt: "2026-06-25T10:00:00Z",
    isFollowing: true,
  },
  {
    id: "2",
    authorId: "user-2",
    authorName: "Bob Waves",
    authorHandle: "@bobwaves",
    content: "New product drop for coily hair types",
    createdAt: "2026-06-25T09:30:00Z",
    isFollowing: false,
  },
  {
    id: "3",
    authorId: "user-3",
    authorName: "Curly Dev",
    authorHandle: "@curlydev",
    content: "Shipping new features today! 💻",
    createdAt: "2026-06-25T08:00:00Z",
    isFollowing: true,
  },
];

function EmptyFollowingState() {
  return (
    <div className="comunidad-page__empty">
      <div className="comunidad-page__empty-icon" aria-hidden="true">
        👋
      </div>
      <h2 className="comunidad-page__empty-title">No posts yet</h2>
      <p className="comunidad-page__empty-text">
        You&apos;re not following anyone yet. Explore the community and follow
        curly hair enthusiasts to see their posts here.
      </p>
      <a href="/comunidad" className="button button--primary">
        Discover people
      </a>
    </div>
  );
}

export default function ComunidadPage() {
  const [activeTab, setActiveTab] = useState<FeedTab>("all");
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // TODO: Replace with actual API call
    const timer = setTimeout(() => {
      setPosts(MOCK_POSTS);
      setIsLoading(false);
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  const filteredPosts = activeTab === "following" 
    ? posts.filter((p) => p.isFollowing) 
    : posts;

  const handleFollowChange = useCallback((postId: string, isFollowing: boolean) => {
    setPosts((prev) =>
      prev.map((p) => (p.id === postId ? { ...p, isFollowing } : p))
    );
  }, []);

  return (
    <main className="comunidad-page">
      <h1 className="comunidad-page__title">Community</h1>

      <div className="comunidad-page__tabs" role="tablist" aria-label="Feed filter">
        <button
          role="tab"
          aria-selected={activeTab === "all"}
          aria-controls="feed-panel"
          id="tab-all"
          className={`comunidad-page__tab ${activeTab === "all" ? "comunidad-page__tab--active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          All
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "following"}
          aria-controls="feed-panel"
          id="tab-following"
          className={`comunidad-page__tab ${activeTab === "following" ? "comunidad-page__tab--active" : ""}`}
          onClick={() => setActiveTab("following")}
        >
          Following
        </button>
      </div>

      <div
        id="feed-panel"
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        className="comunidad-page__feed"
      >
        {isLoading ? (
          <div className="comunidad-page__skeleton" aria-busy="true" aria-label="Loading posts" />
        ) : activeTab === "following" && filteredPosts.length === 0 ? (
          <EmptyFollowingState />
        ) : (
          <ul className="comunidad-page__post-list">
            {filteredPosts.map((post) => (
              <li key={post.id} className="comunidad-page__post">
                <article>
                  <header className="comunidad-page__post-header">
                    <div>
                      <span className="comunidad-page__post-author">{post.authorName}</span>
                      <span className="comunidad-page__post-handle">{post.authorHandle}</span>
                    </div>
                    <FollowButton
                      userId={post.authorId}
                      initialIsFollowing={post.isFollowing}
                      onFollowChange={(isFollowing) => handleFollowChange(post.id, isFollowing)}
                    />
                  </header>
                  <p className="comunidad-page__post-content">{post.content}</p>
                  <time className="comunidad-page__post-time" dateTime={post.createdAt}>
                    {new Date(post.createdAt).toLocaleDateString()}
                  </time>
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

// Re-import FollowButton for use in comunidad page
import { FollowButton } from "../../components/perfil/FollowButton";