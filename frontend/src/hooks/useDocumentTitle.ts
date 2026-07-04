import { useEffect } from "react";

const APP_TITLE = "maimai Score Hub";

export function useDocumentTitle(pageTitle?: string | null) {
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} - ${APP_TITLE}` : APP_TITLE;
  }, [pageTitle]);
}
