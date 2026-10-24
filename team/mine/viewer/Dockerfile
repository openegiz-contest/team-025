FROM nginx:1.25-alpine
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY entrypoint.sh /entrypoint.sh
COPY public/ /usr/share/nginx/html/
# World-readable regardless of host file modes (a 0600 file on the host
# would otherwise be copied as-is and nginx answers 403 for it).
RUN chmod +x /entrypoint.sh && chmod -R a+rX /usr/share/nginx/html
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
