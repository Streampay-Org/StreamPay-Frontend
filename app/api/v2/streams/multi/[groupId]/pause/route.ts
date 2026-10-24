import { handleGroupAction } from "../actions";

type Context = { params: Promise<{ groupId: string }> };

export async function POST(request: Request, { params }: Context) {
  const { groupId } = await params;
  return handleGroupAction(request, groupId, "pause");
}