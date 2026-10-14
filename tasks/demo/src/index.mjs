// A pretend application with one background job: send a welcome email.
//
// The first version of this handler read `task.payload.user.email`. The
// task carries `{ userId }`, so it threw, the task went to the dead-letter
// with "Cannot read properties of undefined (reading 'email')", and that one
// line - read back over MCP - is what pointed at the fix below. Nothing was
// lost: the task waited, and a retry after the fix delivered it.
import { handler } from "../../sdk/index.mjs";

const USERS = {
  user_123: { email: "amina@example.tz", name: "Amina" },
  user_456: { email: "juma@example.tz", name: "Juma" },
};

async function sendWelcomeEmail(task) {
  const user = USERS[task.payload.userId];
  // An unknown user will still be unknown on the next try: fail for good.
  if (!user) throw Object.assign(new Error(`unknown user ${task.payload.userId}`), { status: 400 });
  return { sent: true, to: user.email, name: user.name, attempt: task.attempt };
}

export default {
  fetch(request, env) {
    return handler(env.TASKS_KEY, async (task) => {
      if (task.name === "send-welcome-email") return sendWelcomeEmail(task);
      throw Object.assign(new Error(`no handler for ${task.name}`), { status: 400 });
    })(request);
  },
};
