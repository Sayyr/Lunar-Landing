#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define DURATION_SECONDS 4

static int parseNumber(const char *text, double *value)
{
	char	*end;

	*value = strtod(text, &end);
	if (end == text || *end != '\0')
		return 0;
	return 1;
}

int main(int argc, char **argv)
{
	double	lat;
	double	lon;
	double	height;

	if (argc != 4)
	{
		fprintf(stderr, "usage: simulate-slow <lat> <lon> <height>\n");
		return 1;
	}
	if (!parseNumber(argv[1], &lat) || !parseNumber(argv[2], &lon) || !parseNumber(argv[3], &height))
	{
		fprintf(stderr, "invalid number\n");
		return 2;
	}
	sleep(DURATION_SECONDS);
	printf("{\"lat\":%g,\"lon\":%g,\"height\":%g,\"duration_s\":%d,\"earth_elevation_deg\":-0.8,\"earth_visible\":false}\n",
		lat, lon, height, DURATION_SECONDS);
	return 0;
}
