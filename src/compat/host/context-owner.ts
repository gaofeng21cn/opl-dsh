import { Context } from '@deepseek-ai/cordis'

/** Share account observations between plugins in the same official Host. */
export function contextOwner(ctx: Context): object {
  const root: unknown = Reflect.get(Context, 'root')
  return (typeof root === 'symbol' ? Reflect.get(ctx, root) : ctx.root) ?? ctx
}
