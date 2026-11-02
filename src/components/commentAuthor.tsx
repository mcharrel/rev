import { codeCommentDestination, commentDestination, type PullTab, type ThreadMessage } from '../api/workspace.js';
import { IconUser } from '../icons.js';

export function CommentAuthor({ author, agent = false }: { author: string; agent?: boolean }) {
  const githubUser = !agent && author !== 'You' && /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?$/i.test(author);
  return <span className="comment-author">
    {githubUser
      ? <img className="comment-avatar" src={`https://github.com/${encodeURIComponent(author)}.png?size=48`} alt="" width="24" height="24" loading="lazy" referrerPolicy="no-referrer" />
      : <span className="comment-avatar comment-avatar-fallback" aria-hidden="true"><IconUser /></span>}
    <strong>{author}</strong>
  </span>;
}

export function codeCommentPlaceholder(tab?: Pick<PullTab, 'info' | 'viewer'> & Partial<Pick<PullTab, 'comments'>>, message?: ThreadMessage): string {
  const destination = tab ? message ? commentDestination(tab, message) : codeCommentDestination(tab) : null;
  if (message?.destination === 'local' && destination !== 'local') return 'Leave a reply...';
  return destination === 'local' ? 'Leave a comment, agent will respond...'
    : destination === 'github' ? 'Post a comment on GitHub...' : 'Leave a comment...';
}
