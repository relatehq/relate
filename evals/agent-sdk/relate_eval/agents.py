"""Example alternative agent scaffold, selected with a module:factory string."""

from inspect_ai.model import ChatMessageUser
from inspect_ai.solver import solver


@solver
def discovery_first():
    """Spend one cell on graph discovery before entering the standard tool loop."""

    async def solve(state, generate):
        result = await state.tools[0](code="console.log(relate.describe());")
        state.messages.append(
            ChatMessageUser(content="Initial SDK discovery:\n" + result)
        )
        if not state.completed:
            state = await generate(state, tool_calls="loop")
        return state

    return solve
