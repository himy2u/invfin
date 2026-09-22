import { render, waitFor } from "@testing-library/react-native";
import LoginScreen from "../app/login";

jest.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithOtp: jest.fn().mockResolvedValue({ error: null }),
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: jest.fn().mockReturnValue({ data: { subscription: { unsubscribe: jest.fn() } } }),
    },
  },
}));

describe("LoginScreen", () => {
  it("renders the email step by default", async () => {
    const { getByTestId } = await render(<LoginScreen />);
    await waitFor(() => expect(getByTestId("login-screen")).toBeTruthy());
    expect(getByTestId("email-input")).toBeTruthy();
    expect(getByTestId("send-code-button")).toBeTruthy();
  });
});
